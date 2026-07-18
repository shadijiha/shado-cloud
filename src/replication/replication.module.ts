import { MiddlewareConsumer, Module, NestModule, Scope } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { GoogleDriveBackupService } from "./google-drive-backup.service";
import { TrustedIpMiddleware } from "./trusted-ip.middleware";
import { ReplicationController } from "./replication.controller";
import { ReplicaLinkClient } from "./replica-link.client";
import { ConditionalModule, ConfigModule, ConfigService } from "@nestjs/config";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "src/file-system/file-system.service";
import { ScheduleModule } from "@nestjs/schedule";
import yamlConfigLoader from "../config/config.loader";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { EnvVariables } from "src/config/config.validator";
import { LoggerToDb } from "src/logging";
import { EmailService } from "src/admin/email.service";
import { REDIS_CACHE } from "src/util";
import Redis from "ioredis";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { AUTH_SERVICE } from "src/auth/auth.constants";
import { SignedServiceSerializer } from "src/auth/service-auth.util";

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
      ClientsModule.registerAsync([
         {
            name: AUTH_SERVICE,
            useFactory: (config: ConfigService<EnvVariables>) => ({
               transport: Transport.TCP,
               options: {
                  host: config.get("cross-service.auth-api.host", { infer: true }),
                  port: config.get("cross-service.auth-api.port.tcp", { infer: true }) ?? 11002,
                  serializer: new SignedServiceSerializer(config.get("cross-service.secret", { infer: true })),
               },
            }),
            inject: [ConfigService],
         },
      ]),
   ],
   controllers: [ReplicationController],
   providers: [
      ReplicationService,
      ReplicaLinkClient,
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
      ServiceKeyGuard,
      EmailService,
      {
         provide: REDIS_CACHE,
         useFactory: (config: ConfigService<EnvVariables>) => {
            return new Redis({
               host: config.get("redis.host", { infer: true }),
               port: config.get("redis.port", { infer: true }),
               password: config.get("redis.password", { infer: true }),
            });
         },
         scope: Scope.DEFAULT,
         inject: [ConfigService],
      },

   ],
})
export class ReplicationModule implements NestModule {
   configure(consumer: MiddlewareConsumer) {
      consumer.apply(TrustedIpMiddleware).forRoutes("replication");
   }
}
