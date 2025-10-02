import { Global, type MiddlewareConsumer, Module, RequestMethod, Scope } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./auth/auth.module";
import { FilesModule } from "./files/files.module";
import { DirectoriesModule } from "./directories/directories.module";
import { TempUrlModule } from "./temp-url/temp-url.module";
import { RequestContextModule } from "nestjs-request-context";
import { AdminModule } from "./admin/admin.module";
import { UserProfileModule } from "./user-profile/user-profile.module";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD, INQUIRER } from "@nestjs/core";
import { CORPMiddleware } from "./corp.middleware";
import { LoggerToDb } from "./logging";
import { Log } from "./models/log";
import { DataSource } from "typeorm";
import { AbstractFileSystem } from "./file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "./file-system/file-system.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EnvVariables, ReplicationRole, validate } from "./config/config.validator";
import { isDev, REDIS_CACHE } from "./util";
import Redis from "ioredis";
import { FeatureFlagService } from "./admin/feature-flag.service";
import { FeatureFlag } from "./models/admin/featureFlag";
import { ReplicationModule } from "./replication/replication.module";

@Global()
@Module({
   imports: [TypeOrmModule.forFeature([FeatureFlag])],
   providers: [
      {
         provide: LoggerToDb,
         scope: Scope.TRANSIENT,
         inject: [DataSource, INQUIRER, FeatureFlagService, ConfigService],
         useFactory: (
            dataSource: DataSource,
            parentClass: object,
            featureFlagService: FeatureFlagService,
            config: ConfigService<EnvVariables>,
         ) => {
            return new LoggerToDb(
               parentClass?.constructor.name ?? "UnknownSource",
               dataSource.getRepository(Log),
               featureFlagService,
               config,
            );
         },
      },
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
      {
         provide: REDIS_CACHE,
         useFactory: (config: ConfigService<EnvVariables>) => {
            return new Redis({
               host: config.get("REDIS_HOST"),
               port: Number(config.get("REDIS_PORT")),
               password: config.get("REDIS_PASSWORD"),
            });
         },
         scope: Scope.DEFAULT,
         inject: [ConfigService],
      },
      FeatureFlagService,
   ],
   exports: [LoggerToDb, AbstractFileSystem, REDIS_CACHE, FeatureFlagService],
})
export class GlobalUtilityModule {}

@Module({
   imports: [
      GlobalUtilityModule,
      ConfigModule.forRoot({
         envFilePath: [".env"],
         expandVariables: true,
         isGlobal: true,
         validate: validate,
      }),
      RequestContextModule,
      AuthModule,
      TypeOrmModule.forRootAsync({
         useFactory: (config: ConfigService<EnvVariables>) => {
            return {
               type: config.get("DB_TYPE") as any,
               host: config.get("DB_HOST"),
               port: Number(config.get("DB_PORT")),
               username: config.get("DB_USERNAME"),
               password: config.get("DB_PASSWORD"),
               database: config.get<string>("DB_NAME"),
               entities: ["dist/src/models/**/*{.ts,.js}"],
               synchronize: isDev(config),
               logging: false,
               // Only define cache if REDIS_HOST is defined in env
               cache: {
                  type: "redis",
                  duration: 1000, // 1 second
                  options: {
                     host: config.get("REDIS_HOST"),
                     port: Number(config.get("REDIS_PORT")),
                     password: config.get("REDIS_PASSWORD"),
                  },
                  alwaysEnabled: true,
               },
            };
         },
         inject: [ConfigService],
      }),
      ThrottlerModule.forRoot([{
         ttl: 30,
         limit: 1000,
      }]),
      FilesModule,
      DirectoriesModule,
      TempUrlModule,
      AdminModule,
      UserProfileModule,
      ReplicationModule,
   ],
   controllers: [AppController],
   providers: [
      AppService,
      {
         provide: APP_GUARD,
         useClass: ThrottlerGuard,
      },
   ],
})
export class AppModule {
   configure(consumer: MiddlewareConsumer) {
      consumer.apply(CORPMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
   }
}
