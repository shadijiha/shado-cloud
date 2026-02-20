import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { LocalNetworkMiddleware } from "./local-network.middleware";
import { ReplicationController } from "./replication.controller";
import { ConditionalModule, ConfigModule } from "@nestjs/config";
import { ReplicationRole, validate } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "src/file-system/file-system.service";
import { ScheduleModule } from "@nestjs/schedule";
import { GoogleDriveBackupService } from "./google-drive-backup.service";
import { AdminModule } from "src/admin/admin.module";
/**
 * This module is responsible for replicating data between the primary and secondary PCs
 * Used to ensure that the primary and secondary PCs are in sync
 *
 * ------------------------                                     -----------------------------
 * | Rasberry Pi (Master) |  -------- Local Network -------->   | Shadi's big PC (replica)  |
 * ------------------------                                     -----------------------------
 */
@Module({
   imports: [
      ConditionalModule.registerWhen(
         ConfigModule.forFeature(() => {
            return {
               envFilePath: [".env"],
               expandVariables: true,
               isGlobal: true,
               validate: validate,
            };
         }),
         (env: NodeJS.ProcessEnv) => env.REPLICATION_ROLE == ReplicationRole.Replica,
      ),
      ScheduleModule.forRoot(),
      AdminModule,
   ],
   controllers: [ReplicationController],
   providers: [
      ReplicationService,
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
      GoogleDriveBackupService,
   ],
})
export class ReplicationModule implements NestModule {
   configure(consumer: MiddlewareConsumer) {
      consumer.apply(LocalNetworkMiddleware).forRoutes("replication");
   }
}
