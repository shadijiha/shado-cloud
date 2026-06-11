import { Injectable, Logger, OnModuleInit, StreamableFile } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EnvVariables, ReplicationRole } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import * as path from "path";
import { Readable } from "stream";

@Injectable()
export class ReplicationService implements OnModuleInit {
   private readonly logger = new Logger(ReplicationService.name);
   private isReplicating = false; // lock flag

   constructor(private readonly config: ConfigService<EnvVariables>, private readonly fs: AbstractFileSystem) { }

   public onModuleInit() {
      void this.replicate();
   }

   @Cron(CronExpression.EVERY_MINUTE, { name: "replication:replicate" })
   public async replicate() {
      if (this.isReplicating) {
         this.logger.warn("A replication job is currently running. Skipping this Cron iteration");
         return;
      }

      this.isReplicating = true;
      try {
         if (this.isReplica()) {
            this.logger.log("Replicating data from master...");

            if (!this.config.get("this-service.replication.master-or-replica-ip", { infer: true })) {
               this.logger.error("Master IP is not set");
               return;
            }

            const masterIp = "http://" + this.config.get("this-service.replication.master-or-replica-ip", { infer: true });
            const replicaFiles = await this.listCloudDir();
            const masterFiles: typeof replicaFiles = await (await fetch(`${masterIp}/replication/listall`)).json();

            // Files to replicate
            const replicaDoesNotHave = masterFiles.filter(
               (e) => !replicaFiles.find((f) => this.pathEquals(f.path, e.path)),
            );
            this.logger.log(`${replicaDoesNotHave.length} Files to replicate`);

            let filesReplicated = 0;
            for (const file of replicaDoesNotHave) {
               if (!this.fs.existsSync(path.join(this.cloudDir, file.path))) {
                  this.fs.mkdirSync(path.join(this.cloudDir, path.dirname(file.path)), { recursive: true });
               }
               const response = await fetch(`${masterIp}/replication/getfile/${encodeURIComponent(file.path)}`);
               if (!response.ok || !response.body) {
                  this.logger.error(`Failed to download file ${file.path}, status: ${response.status}, text: ${await response.text()}`);
               }
               const filePath = path.join(this.cloudDir, file.path);

               const dest = this.fs.createWriteStream(filePath);
               await new Promise<void>((resolve, reject) => {
                  dest.on("finish", resolve);
                  dest.on("error", reject);

                  void (async () => {
                     try {
                        // Stream chunks directly to file
                        for await (const chunk of response.body as any) {
                           dest.write(chunk);
                        }
                        dest.end();
                     } catch (err) {
                        reject(err);
                     }
                  })();
               });

               this.logger.log(`Done ${filesReplicated + 1} of ${replicaDoesNotHave.length} files`);
               filesReplicated++;
            }

            // Files to delete
            const masterDoesNotHave = replicaFiles.filter(
               (e) => !masterFiles.find((f) => this.pathEquals(f.path, e.path)),
            );
            this.logger.log(`${masterDoesNotHave.length} Files to delete`);
            let filesDeleted = 0;
            for (const file of masterDoesNotHave) {
               this.fs.unlinkSync(path.join(this.cloudDir, file.path));
               filesDeleted++;

               this.logger.log(`Deleted ${filesDeleted} of ${masterDoesNotHave.length} (file: ${file.path})`);
            }
         } else if (this.isMaster()) {
            // No op
         } else {
            this.logger.error(`Replication role is unknown ${this.config.get("this-service.replication.role", { infer: true })}`);
         }
      } catch (error) {
         const e = error as Error;
         const fullMessage = `${this.config.get("this-service.replication.role", { infer: true })} encountered an exception: ${e.message}`;
         this.logger.error(fullMessage, e.stack);
      } finally {
         this.isReplicating = false;
      }
   }

   public async listCloudDir() {
      return this.listRecusively(this.cloudDir);
   }

   public async getFile(path_: string) {
      return new StreamableFile(this.fs.createReadStream(path.join(this.cloudDir, path_)));
   }

   private async listRecusively(path_: string) {
      const entries = this.fs.readdirSync(path_);

      // Get files within the current directory and add a path key to the file objects
      const files = entries
         .filter((file) => !file.isDirectory())
         .map((file) => ({ ...file, path: path.relative(this.config.get("this-service.cloud-dir", { infer: true }), path_ + "/" + file.name) }));

      // Get folders within the current directory
      const folders = entries.filter((folder) => folder.isDirectory());

      /*
       * Add the found files within the subdirectory to the files array by calling the
       * current function itself
       */
      for (const folder of folders) {
         files.push(...(await this.listRecusively(path.join(path_, folder.name))));
      }
      return files;
   }

   private isMaster() {
      return this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Master ||
         this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Primary;
   }

   private isReplica() {
      return this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Replica;
   }

   private pathEquals(path1: string, path2: string) {
      const normalizedPath1 = path.normalize(path.resolve(path1));
      const normalizedPath2 = path.normalize(path.resolve(path2));
      return normalizedPath1 == normalizedPath2;
   }

   private get cloudDir() {
      return this.config.get("this-service.cloud-dir", { infer: true });
   }
}
