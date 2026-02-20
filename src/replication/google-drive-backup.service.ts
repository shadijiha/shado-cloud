import { Inject, Injectable } from "@nestjs/common";
import { AdminService } from "src/admin/admin.service";
import { LoggerToDb } from "src/logging";
import { google } from "googleapis";
import { Cron } from "@nestjs/schedule";
import path from "path";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";

@Injectable()
export class GoogleDriveBackupService {
   constructor(
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly adminService: AdminService,
      @Inject() private readonly config: ConfigService<EnvVariables>,
      private readonly fs: AbstractFileSystem,
   ) {}

   private async getDriveClient() {
      const auth = new google.auth.GoogleAuth({
         keyFile: "/home/shadi/Desktop/google-credentials.json", // OAuth credentials
         scopes: ["https://www.googleapis.com/auth/drive"],
      });

      return google.drive({ version: "v3", auth });
   }

   @Cron("0 6 * * *") // Runs every day at 6:00 AM
   async handleDailyUpload() {
      this.logger.log("Running daily Drive upload job...");

      const drive = await this.getDriveClient();
      const backupPath = await this.adminService.runCloudBackup(null);
      const filePath = path.resolve(backupPath);
      const driveFileName = "shado-cloud-backup.zip";
      const folderId = "SHADO_CLOUD_BACKUP"; // optional

      // Search existing file
      const search = await drive.files.list({
         q: `name='${driveFileName}' and '${folderId}' in parents and trashed=false`,
         fields: "files(id, name)",
      });

      const existing = search.data.files?.[0];

      if (existing) {
         this.logger.log(`Updating existing file: ${driveFileName}`);

         await drive.files.update({
            fileId: existing.id!,
            media: {
               mimeType: "application/octet-stream",
               body: this.fs.createReadStream(filePath),
            },
         });

         this.logger.log("File updated successfully.");
      } else {
         this.logger.log(`Creating new file: ${driveFileName}`);

         await drive.files.create({
            requestBody: {
               name: driveFileName,
               parents: [folderId],
            },
            media: {
               mimeType: "application/octet-stream",
               body: this.fs.createReadStream(filePath),
            },
         });

         this.logger.log("File created successfully.");
         await this.adminService.deleteBackupFile(filePath);
      }
   }
}
