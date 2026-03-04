import { Global, Module, Scope } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { INQUIRER } from "@nestjs/core";
import { DataSource } from "typeorm";
import { StorageMicroserviceController } from "./storage-microservice.controller";
import { FilesService } from "../files/files.service";
import { DirectoriesService } from "../directories/directories.service";
import { TempUrlService } from "../temp-url/tempUrl.service";
import { ThumbnailCacheInterceptor } from "../files/thumbnail-cache.interceptor";
import { AuthService } from "../auth/auth.service";
import { AbstractFileSystem } from "../file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "../file-system/file-system.service";
import { LoggerToDb } from "../logging";
import { FeatureFlagService } from "../admin/feature-flag.service";
import { EnvVariables, validate } from "../config/config.validator";
import { REDIS_CACHE, isDev } from "../util";
import { User } from "../models/user";
import { UploadedFile } from "../models/uploadedFile";
import { SearchStat } from "../models/stats/searchStat";
import { FileAccessStat } from "../models/stats/fileAccessStat";
import { TempUrl } from "../models/tempUrl";
import { FeatureFlag } from "../models/admin/featureFlag";
import { Log } from "../models/log";
import Redis from "ioredis";

import { ScheduleModule } from "@nestjs/schedule";
import { StorageHeartbeatService } from "./storage-heartbeat.service";

@Global()
@Module({
   imports: [
      ScheduleModule.forRoot(),
      ConfigModule.forRoot({
         envFilePath: [".env"],
         expandVariables: true,
         isGlobal: true,
         validate,
      }),
      TypeOrmModule.forRootAsync({
         useFactory: (config: ConfigService<EnvVariables>) => ({
            type: config.get("DB_TYPE") as any,
            host: config.get("DB_HOST"),
            port: Number(config.get("DB_PORT")),
            username: config.get("DB_USERNAME"),
            password: config.get("DB_PASSWORD"),
            database: config.get<string>("DB_NAME"),
            entities: ["dist/src/models/**/*{.ts,.js}"],
            synchronize: isDev(config),
            logging: false,
            cache: {
               type: "redis",
               duration: 1000,
               options: {
                  host: config.get("REDIS_HOST"),
                  port: Number(config.get("REDIS_PORT")),
                  password: config.get("REDIS_PASSWORD"),
               },
               alwaysEnabled: true,
            },
         }),
         inject: [ConfigService],
      }),
      TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl, FeatureFlag, Log]),
   ],
   controllers: [StorageMicroserviceController],
   providers: [
      FilesService,
      DirectoriesService,
      TempUrlService,
      ThumbnailCacheInterceptor,
      AuthService,
      FeatureFlagService,
      StorageHeartbeatService,
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
      {
         provide: REDIS_CACHE,
         useFactory: (config: ConfigService<EnvVariables>) =>
            new Redis({
               host: config.get("REDIS_HOST"),
               port: Number(config.get("REDIS_PORT")),
               password: config.get("REDIS_PASSWORD"),
            }),
         inject: [ConfigService],
      },
      {
         provide: LoggerToDb,
         scope: Scope.TRANSIENT,
         inject: [DataSource, INQUIRER, FeatureFlagService, ConfigService],
         useFactory: (
            dataSource: DataSource,
            parentClass: object,
            featureFlagService: FeatureFlagService,
            config: ConfigService<EnvVariables>,
         ) =>
            new LoggerToDb(
               parentClass?.constructor.name ?? "StorageMicroservice",
               dataSource.getRepository(Log),
               featureFlagService,
               config,
            ),
      },
   ],
})
export class StorageMicroserviceModule {}
