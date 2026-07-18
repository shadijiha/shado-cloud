import { Module, NestModule } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminModule } from "src/admin/admin.module";
import { GoogleDriveBackupService } from "./google-drive-backup.service";

/**
 * Hosts the daily off-site backup to Google Drive ({@link GoogleDriveBackupService}).
 * Kept separate from the master↔replica sync so it can be enabled independently.
 */
@Module({
   imports: [
      ScheduleModule.forRoot(),
      AdminModule,
   ],
   providers: [
      GoogleDriveBackupService,
   ],
})
export class GoogleBackupModule {
}