import { Inject, Injectable, HttpException, HttpStatus, MessageEvent } from "@nestjs/common";
import { InjectDataSource, InjectEntityManager, InjectRepository } from "@nestjs/typeorm";
import { exec } from "child_process";
import { LoggerToDb } from "../logging";
import { Log } from "../models/log";
import { DataSource, EntityManager, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { promisify } from "util";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { DatabaseGetTableRequest } from "./adminApiTypes";
import { EncryptedPassword } from "src/models/EncryptedPassword";
import { User } from "src/models/user";
import { EmailService } from "./email.service";
import * as fs from "fs";
import * as path from "path";
import archiver from "archiver";
import { Observable, Subject } from "rxjs";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";

@Injectable()
export class AdminService {


   public constructor(
      @InjectRepository(Log) private readonly logRepo: Repository<Log>,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly config: ConfigService<EnvVariables>,
      private readonly featureFlagService: FeatureFlagService,
      @InjectDataSource() private readonly dataSource: DataSource,
      @InjectEntityManager() private readonly entityManager: EntityManager,
      @Inject() private readonly emailService: EmailService,
      @Inject() private readonly abstractFs: AbstractFileSystem,
   ) {

   }

   /**
    * @returns Returns all logs in the database
    */
   public async all() {
      return (await this.logRepo.find({ relations: ["user"] })).sort((a, b) => {
         return b.created_at.getTime() - a.created_at.getTime();
      });
   }

   /**
    * Deletes Logs by their ids
    * @param ids
    */
   public async deleteByIds(ids: number[]) {
      await this.logRepo.delete(ids);
   }

   public async redeploy(type: "backend" | "frontend") {
      // We can't have a promise that resolves / rejects because github webhooks have a 10 second timeout
      // there for we'll only acknowladge to github webhooks. If there's an error, it will be logged only
      // Github won't know about it

      // Check if the feature flag is enabled
      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, `auto_${type}_redeploy`)) {
         this.logger.warn(
            `[${AdminService.name}:${this.redeploy.name}(type=${type})] attempt to redeploy while feature flag is disabled`,
         );
         return;
      }

      // Send email for deployment start
      this.emailService.sendEmail({
         subject: `Shado Cloud - ${type} deployment start`,
         text: `Deployment was triggered for Shado Cloud ${type == "backend" ? "NestJS" : "React"} app`,
      });

      // Check and log the node version
      const nodeVersion = (await this.execSync("node -v")).stdout;
      this.logger.log(`[${AdminService.name}:${this.redeploy.name}(type=${type})] Node version: ${nodeVersion}`);

      // Check if FRONTEND_DEPLOY_PATH is set
      if (type == "frontend" && !this.config.get("FRONTEND_DEPLOY_PATH")) {
         this.logger.error(
            `[${AdminService.name}:${this.redeploy.name}(type=${type})] attempt to redeploy while FRONTEND_DEPLOY_PATH is not set`,
         );
         return;
      }

      const fullcommand = `./deploy.sh`;
      const result = exec(
         fullcommand,
         type == "backend" ? undefined : { cwd: this.config.get<string>("FRONTEND_DEPLOY_PATH") },
      );

      result.stdout.on("data", (data) => {
         this.logger.log(data);
      });
      result.stderr.on("data", (data) => {
         this.logger.error(data);
      });

      const exitFn = async (code) => {
         if (code == 0) {
            this.logger.log(`${fullcommand} exited successfully`);
            await this.emailService.sendEmail({
               subject: "Shado Cloud - Successful deployment",
               html: "<h2>Shado cloud nestjs app has succesfully deployed!</h2>",
            });
         } else {
            this.logger.error(`${fullcommand} exited with code ${code}`);
            await this.emailService.sendEmail({
               subject: `Shado Cloud ${type} - Failed deployment`,
               html: `
               <h2>Shado cloud nestjs app has failed</h2>
               <code>
                  ${fullcommand} exited with code ${code}
               </code>
               `,
            });
         }
      };

      result.on("close", exitFn);
      result.on("exit", exitFn);
      result.on("disconnect", exitFn);
   }

   /**
    * Database admin methods
    */
   public async getTables() {
      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, "database_api_access")) {
         throw new Error("Database API access is disabled");
      }

      const tables = this.dataSource.entityMetadatas.map((meta) => meta.tableName);
      return tables.map((table) => {
         return {
            table,
            columns: this.entityManager.getRepository(table).metadata.columns.map((col) => col.propertyName),
         };
      });
   }

   public async getTable(tableName: string, request: DatabaseGetTableRequest) {
      const { limit, order_by, order_column } = request;
      const tables = await this.getTables(); // <-- If feature flag is disabled this will throw an error
      if (!tables.find((entry) => entry.table == tableName)) {
         throw new Error(`Table ${tableName} does not exist`);
      }

      // Verify that the table is not a password table
      if (tableName == this.entityManager.getRepository(EncryptedPassword).metadata.tableName) {
         throw new Error("Table is encrypted");
      }

      // Verify limit
      if ((!Number.isNaN(parseInt(limit as any)) && limit < 1) || limit > 500) {
         throw new Error("Limit must be between 1 and 500");
      }

      // Verify order_by
      if (!DatabaseGetTableRequest.OrderyByOptions.includes(order_by)) {
         throw new Error("order_by must be either " + DatabaseGetTableRequest.OrderyByOptions.join(" or "));
      }

      // Verify order_column
      const columns = tables.find((entry) => entry.table == tableName)?.columns;
      if (order_column && !columns.includes(order_column)) {
         throw new Error(`Column ${order_column} does not exist in table ${tableName}`);
      }

      const result = await this.dataSource
         .createQueryBuilder()
         .select()
         .from(tableName, "")
         .where("1=1")
         .orderBy(order_column, order_by)
         .limit(limit)
         .getRawMany();

      // If table is user remove password
      if (this.entityManager.getRepository(User).metadata.tableName == tableName) {
         for (const row of result) {
            row.password = "<hidden>";
         }
      }

      return result;
   }

   private async execSync(command: string) {
      return promisify(exec)(command);
   }

   public async generateServerSetupBackup(sudoPassword?: string): Promise<Buffer> {
      const tmpDir = `/tmp/server-setup-${Date.now()}`;
      await fs.promises.mkdir(tmpDir, { recursive: true });

      const errors: string[] = [];
      const sudoPrefix = sudoPassword ? `echo '${sudoPassword}' | sudo -S` : "";
      const isMac = process.platform === "darwin";

      // 1. MySQL dump
      try {
         const dbHost = this.config.get("DB_HOST") || "localhost";
         const dbUser = this.config.get("DB_USERNAME");
         const dbPass = this.config.get("DB_PASSWORD");
         const mysqldump = isMac ? "/opt/homebrew/bin/mysqldump" : "mysqldump";
         
         const dumpCmd = `${mysqldump} -h ${dbHost} -u ${dbUser} -p'${dbPass}' --all-databases > ${tmpDir}/mysql-dump.sql`;
         await this.execSync(dumpCmd);
      } catch (e) {
         errors.push(`MySQL dump failed: ${e.message}`);
      }

      // 2. Apache config
      const apacheConfPath = isMac 
         ? "/opt/homebrew/etc/httpd/httpd.conf"
         : "/etc/apache2/sites-available/000-default.conf";
      try {
         if (sudoPassword && !isMac) {
            await this.execSync(`${sudoPrefix} cat ${apacheConfPath} > ${tmpDir}/apache-config.conf`);
         } else {
            const content = await fs.promises.readFile(apacheConfPath, "utf-8");
            await fs.promises.writeFile(`${tmpDir}/apache-config.conf`, content);
         }
      } catch (e) {
         if (e.code === "EACCES" || e.message?.includes("Permission denied")) {
            throw new HttpException("SUDO_REQUIRED", HttpStatus.FORBIDDEN);
         }
         errors.push(`Apache config failed: ${e.message}`);
      }

      // 3. .env file
      try {
         const envPath = path.join(process.cwd(), ".env");
         const content = await fs.promises.readFile(envPath, "utf-8");
         await fs.promises.writeFile(`${tmpDir}/env-file.txt`, content);
      } catch (e) {
         errors.push(`.env file failed: ${e.message}`);
      }

      // Write errors log if any
      if (errors.length > 0) {
         await fs.promises.writeFile(`${tmpDir}/errors.txt`, errors.join("\n"));
      }

      // Create zip
      const zipBuffer = await this.createZipBuffer(tmpDir);

      // Cleanup
      await fs.promises.rm(tmpDir, { recursive: true, force: true });

      return zipBuffer;
   }

   private createZipBuffer(sourceDir: string): Promise<Buffer> {
      return new Promise((resolve, reject) => {
         const chunks: Buffer[] = [];
         const archive = archiver("zip", { zlib: { level: 9 } });

         archive.on("data", (chunk) => chunks.push(chunk));
         archive.on("end", () => resolve(Buffer.concat(chunks)));
         archive.on("error", reject);

         archive.directory(sourceDir, false);
         archive.finalize();
      });
   }

   public generateServerSetupBackupStream(): Observable<MessageEvent> {
      const subject = new Subject<MessageEvent>();

      this.runServerSetupBackup(subject).catch((e) => {
         subject.next({ data: { type: "error", message: e.message } });
         subject.complete();
      });

      return subject.asObservable();
   }

   private async runServerSetupBackup(subject: Subject<MessageEvent>) {
      const tmpDir = `/tmp/server-setup-${Date.now()}`;
      const zipPath = `/tmp/server-backup-${Date.now()}.zip`;
      await fs.promises.mkdir(tmpDir, { recursive: true });

      const isMac = process.platform === "darwin";

      // Step 1: MySQL dump with progress
      subject.next({ data: { type: "progress", step: "Dumping MySQL databases...", percent: 0, phase: "mysql" } });
      try {
         const dbHost = this.config.get("DB_HOST") || "localhost";
         const dbUser = this.config.get("DB_USERNAME");
         const dbPass = this.config.get("DB_PASSWORD");
         const mysqldump = isMac ? "/opt/homebrew/bin/mysqldump" : "mysqldump";
         
         await new Promise<void>((resolve, reject) => {
            const dumpPath = `${tmpDir}/mysql-dump.sql`;
            const output = fs.createWriteStream(dumpPath);
            const child = require("child_process").spawn(mysqldump, [
               "-h", dbHost,
               "-u", dbUser,
               `-p${dbPass}`,
               "--all-databases"
            ]);

            let bytesWritten = 0;
            child.stdout.on("data", (chunk: Buffer) => {
               bytesWritten += chunk.length;
               output.write(chunk);
               subject.next({ 
                  data: { 
                     type: "progress", 
                     step: "Dumping MySQL databases...", 
                     processedBytes: bytesWritten,
                     phase: "mysql"
                  } 
               });
            });

            child.stderr.on("data", () => {}); // Ignore warnings
            child.on("close", (code: number) => {
               output.end();
               if (code === 0) resolve();
               else reject(new Error(`mysqldump exited with code ${code}`));
            });
            child.on("error", reject);
         });
      } catch (e) {
         await fs.promises.writeFile(`${tmpDir}/mysql-error.txt`, e.message);
         subject.next({ data: { type: "progress", step: "MySQL dump failed", phase: "mysql" } });
      }

      // Step 2: Apache config (quick)
      subject.next({ data: { type: "progress", step: "Copying Apache config...", phase: "copy" } });
      try {
         const apacheConfPath = isMac ? "/opt/homebrew/etc/httpd/httpd.conf" : "/etc/apache2/sites-available/000-default.conf";
         const content = await fs.promises.readFile(apacheConfPath, "utf-8");
         await fs.promises.writeFile(`${tmpDir}/apache-config.conf`, content);
      } catch (e) {
         await fs.promises.writeFile(`${tmpDir}/apache-error.txt`, e.message);
      }

      // Step 3: .env file (quick)
      subject.next({ data: { type: "progress", step: "Copying .env file...", phase: "copy" } });
      try {
         const content = await fs.promises.readFile(path.join(process.cwd(), ".env"), "utf-8");
         await fs.promises.writeFile(`${tmpDir}/env-file.txt`, content);
      } catch (e) {
         await fs.promises.writeFile(`${tmpDir}/env-error.txt`, e.message);
      }

      // Step 4: Create zip with byte progress
      subject.next({ data: { type: "progress", step: "Scanning files...", percent: 0, phase: "zip" } });
      const totalSize = await this.getDirSize(tmpDir);

      await new Promise<void>((resolve, reject) => {
         const output = fs.createWriteStream(zipPath);
         const archive = archiver("zip", { zlib: { level: 9 } });

         archive.on("error", reject);
         output.on("close", resolve);

         archive.on("progress", (progress) => {
            const percent = totalSize > 0 ? Math.min(99, Math.round((progress.fs.processedBytes / totalSize) * 100)) : 0;
            subject.next({ 
               data: { 
                  type: "progress", 
                  step: "Compressing...", 
                  percent, 
                  processedBytes: progress.fs.processedBytes, 
                  totalBytes: totalSize,
                  phase: "zip"
               } 
            });
         });

         archive.pipe(output);
         archive.directory(tmpDir, false);
         archive.finalize();
      });

      await fs.promises.rm(tmpDir, { recursive: true, force: true });

      subject.next({ data: { type: "complete", downloadPath: `/admin/backup/download?file=${encodeURIComponent(zipPath)}` } });
      subject.complete();
   }

   public generateCloudBackupStream(): Observable<MessageEvent> {
      const subject = new Subject<MessageEvent>();

      this.runCloudBackup(subject).catch((e) => {
         subject.next({ data: { type: "error", message: e.message } });
         subject.complete();
      });

      return subject.asObservable();
   }

   private async runCloudBackup(subject: Subject<MessageEvent>) {
      const cloudDir = this.config.get("CLOUD_DIR");
      const zipPath = `/tmp/cloud-backup-${Date.now()}.zip`;

      subject.next({ data: { type: "progress", step: "Scanning files", percent: 0 } });

      // Get total size for progress calculation
      const totalSize = await this.getDirSize(cloudDir);
      let processedSize = 0;

      await new Promise<void>((resolve, reject) => {
         const output = fs.createWriteStream(zipPath);
         const archive = archiver("zip", { zlib: { level: 1 } }); // Fast compression for large files

         archive.on("error", reject);
         output.on("close", resolve);

         archive.on("progress", (progress) => {
            processedSize = progress.fs.processedBytes;
            const percent = Math.min(99, Math.round((processedSize / totalSize) * 100));
            subject.next({ data: { type: "progress", step: "Compressing", percent, processedBytes: processedSize, totalBytes: totalSize } });
         });

         archive.pipe(output);
         archive.directory(cloudDir, "cloud");
         archive.finalize();
      });

      subject.next({ data: { type: "complete", downloadPath: `/admin/backup/download?file=${encodeURIComponent(zipPath)}` } });
      subject.complete();
   }

   private async getDirSize(dir: string): Promise<number> {
      let size = 0;
      const files = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const file of files) {
         const filePath = path.join(dir, file.name);
         if (file.isDirectory()) {
            size += await this.getDirSize(filePath);
         } else {
            const stat = await fs.promises.stat(filePath);
            size += stat.size;
         }
      }
      return size;
   }

   public async getBackupFile(filePath: string): Promise<fs.ReadStream> {
      if (!filePath.startsWith("/tmp/") || !filePath.includes("-backup-")) {
         throw new HttpException("Invalid file path", HttpStatus.BAD_REQUEST);
      }
      if (!fs.existsSync(filePath)) {
         throw new HttpException("Backup file not found or already downloaded", HttpStatus.NOT_FOUND);
      }
      return fs.createReadStream(filePath);
   }

   public deleteBackupFile(filePath: string): void {
      try {
         this.abstractFs.unlinkSync(filePath);
      } catch (e) {
         this.logger.error(`Failed to delete backup file ${filePath}: ${e.message}`);
      }
   }

   /**
    * Background images management
    */
   private getBackgroundsDir(): string {
      const dir = path.join(this.config.get("CLOUD_DIR"), "_system", "backgrounds");
      if (!fs.existsSync(dir)) {
         fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
   }

   public async getBackgroundImages(): Promise<{ images: string[] }> {
      const dir = this.getBackgroundsDir();
      try {
         const files = await fs.promises.readdir(dir);
         const images = files.filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
         return { images };
      } catch {
         return { images: [] };
      }
   }

   public async uploadBackgroundImage(file: Express.Multer.File): Promise<{ filename: string }> {
      if (!file) {
         throw new HttpException("No file provided", HttpStatus.BAD_REQUEST);
      }
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
         throw new HttpException("Invalid file type. Only images allowed.", HttpStatus.BAD_REQUEST);
      }

      const dir = this.getBackgroundsDir();
      const ext = path.extname(file.originalname) || ".jpg";
      const filename = `bg_${Date.now()}${ext}`;
      const filePath = path.join(dir, filename);

      await fs.promises.writeFile(filePath, file.buffer);
      return { filename };
   }

   public async deleteBackgroundImage(filename: string): Promise<void> {
      if (filename.includes("/") || filename.includes("..")) {
         throw new HttpException("Invalid filename", HttpStatus.BAD_REQUEST);
      }
      const filePath = path.join(this.getBackgroundsDir(), filename);
      if (!fs.existsSync(filePath)) {
         throw new HttpException("Image not found", HttpStatus.NOT_FOUND);
      }
      await fs.promises.unlink(filePath);
   }

   public async getBackgroundImageStream(filename: string): Promise<fs.ReadStream> {
      if (filename.includes("/") || filename.includes("..")) {
         throw new HttpException("Invalid filename", HttpStatus.BAD_REQUEST);
      }
      const filePath = path.join(this.getBackgroundsDir(), filename);
      if (!fs.existsSync(filePath)) {
         throw new HttpException("Image not found", HttpStatus.NOT_FOUND);
      }
      return fs.createReadStream(filePath);
   }
}
