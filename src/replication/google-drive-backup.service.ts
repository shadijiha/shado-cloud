import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EnvVariables } from "src/config/config.validator";
import { google } from "googleapis";
import { AdminService } from "src/admin/admin.service";
import { LoggerToDb } from "src/logging";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

const GOOGLE_DRIVE_FOLDER_ID = "1cZIPqmwJkh9gP4DvavzwwJMQ9bBpKWvU";

@Injectable()
export class GoogleDriveBackupService {
    constructor(
        private readonly config: ConfigService<EnvVariables>,
        @Inject() private readonly adminService: AdminService,
        @Inject() private readonly logger: LoggerToDb,
        @Inject() private readonly featureFlagService: FeatureFlagService,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    public async backup() {
        if (await this.featureFlagService.isFeatureFlagEnabled(FeatureFlagNamespace.Replication, "disable_google_drive_db_backup")) {
            this.logger.log("Google Drive backup skipped: feature flag disabled");
            return;
        }

        if (!this.config.get("GOOGLE_CLIENT_ID") || !this.config.get("GOOGLE_REFRESH_TOKEN")) {
            this.logger.warn("Google Drive backup skipped: missing Google OAuth credentials");
            return;
        }

        try {
            this.logger.log("Generating server setup backup...");
            const zipBuffer = await this.adminService.generateServerSetupBackup();
            this.logger.log(`Backup generated (${(zipBuffer.length / 1024).toFixed(1)} KB)`);

            this.logger.log("Uploading to Google Drive...");
            const auth = new google.auth.OAuth2(
                this.config.get("GOOGLE_CLIENT_ID"),
                this.config.get("GOOGLE_CLIENT_SECRET"),
            );
            auth.setCredentials({
                refresh_token: this.config.get("GOOGLE_REFRESH_TOKEN"),
            });
            const drive = google.drive({ version: "v3", auth });

            const env = this.config.get("ENV");
            const fileName = `server-backup-${env}.zip`;
            const { Readable } = require("stream");
            const body = Readable.from(zipBuffer);

            const existing = await drive.files.list({
                q: `name='${fileName}' and '${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false`,
                fields: "files(id)",
            });

            if (existing.data.files?.length) {
                await drive.files.update({
                    fileId: existing.data.files[0].id,
                    media: { mimeType: "application/zip", body },
                });
            } else {
                await drive.files.create({
                    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
                    media: { mimeType: "application/zip", body },
                });
            }

            this.logger.log("Backup uploaded to Google Drive");
        } catch (e) {
            this.logger.error(`Backup failed: ${(e as Error).message}`);
        }
    }
}
