import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EnvVariables } from "src/config/config.validator";
import { google } from "googleapis";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { execSync } from "child_process";
import * as path from "path";

const GOOGLE_DRIVE_FOLDER_ID = "1cZIPqmwJkh9gP4DvavzwwJMQ9bBpKWvU";

@Injectable()
export class GoogleDriveBackupService implements OnModuleInit {
    async onModuleInit() {
        this.backup();
    }

    private readonly logger = new Logger(GoogleDriveBackupService.name);

    constructor(
        private readonly config: ConfigService<EnvVariables>,
        private readonly fs: AbstractFileSystem,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    public async backup() {
        if (!this.config.get("GOOGLE_CLIENT_ID") || !this.config.get("GOOGLE_REFRESH_TOKEN")) {
            this.logger.warn("Google Drive backup skipped: missing Google OAuth credentials");
            return;
        }

        const dbHost = this.config.get("DB_HOST");
        const dbPort = this.config.get("DB_PORT");
        const dbUser = this.config.get("DB_USERNAME");
        const dbPass = this.config.get("DB_PASSWORD");
        const dbName = this.config.get("DB_NAME");

        const env = this.config.get("ENV");
        const dumpFile = `/tmp/${dbName}-${env}.sql`;

        try {
            this.logger.log("Starting MySQL dump...");
            execSync(
                `mysqldump -h ${dbHost} -P ${dbPort} -u ${dbUser} -p${dbPass} --protocol=tcp ${dbName} > ${dumpFile}`,
                { stdio: "pipe" },
            );
            this.logger.log(`Dump created: ${dumpFile} (${(this.fs.statSync(dumpFile).size / 1024).toFixed(1)} KB)`);

            this.logger.log("Uploading to Google Drive...");
            const auth = new google.auth.OAuth2(
                this.config.get("GOOGLE_CLIENT_ID"),
                this.config.get("GOOGLE_CLIENT_SECRET"),
            );
            auth.setCredentials({
                refresh_token: this.config.get("GOOGLE_REFRESH_TOKEN"),
            });
            const drive = google.drive({ version: "v3", auth });

            const fileStream = this.fs.createReadStream(dumpFile);
            const fileName = path.basename(dumpFile);

            // Check if file already exists in the folder
            const existing = await drive.files.list({
                q: `name='${fileName}' and '${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false`,
                fields: "files(id)",
            });

            if (existing.data.files?.length) {
                // Update existing file (preserves Google Drive version history)
                await drive.files.update({
                    fileId: existing.data.files[0].id,
                    media: {
                        mimeType: "application/sql",
                        body: fileStream as any,
                    },
                });
            } else {
                await drive.files.create({
                    requestBody: {
                        name: fileName,
                        parents: [GOOGLE_DRIVE_FOLDER_ID],
                    },
                    media: {
                        mimeType: "application/sql",
                        body: fileStream as any,
                    },
                });
            }

            this.logger.log("Backup uploaded to Google Drive");
        } catch (e) {
            this.logger.error(`Backup failed: ${(e as Error).message}`);
        } finally {
            try { this.fs.unlinkSync(dumpFile); } catch {}
        }
    }
}
