import { MiddlewareConsumer, Module, NestModule, Scope } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { GoogleDriveBackupService } from "./google-drive-backup.service";
import { LocalNetworkMiddleware } from "./local-network.middleware";
import { ReplicationController } from "./replication.controller";
import { ConditionalModule, ConfigModule, ConfigService } from "@nestjs/config";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "src/file-system/file-system.service";
import { ScheduleModule } from "@nestjs/schedule";
import yamlConfigLoader from "../config/config.loader";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { EnvVariables } from "src/config/config.validator";
import { LoggerToDb } from "src/logging";
import { EmailService } from "src/admin/email.service";

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
      ConfigModule.forRoot({
         ignoreEnvFile: true,
         load: [yamlConfigLoader],
         isGlobal: true,
      }),
      ScheduleModule.forRoot(),
   ],
   controllers: [ReplicationController],
   providers: [
      ReplicationService,
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
      ServiceKeyGuard,
      EmailService,
   ],
})
export class ReplicationModule implements NestModule {
   configure(consumer: MiddlewareConsumer) {
      consumer.apply(LocalNetworkMiddleware).forRoutes("replication");
   }
}
