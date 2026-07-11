import { Module, NestModule } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminModule } from "src/admin/admin.module";
import { GoogleDriveBackupService } from "./google-drive-backup.service";


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