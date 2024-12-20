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
import { CacheModule } from "@nestjs/cache-manager";
import redisStore from "cache-manager-ioredis";
import { AbstractFileSystem } from "./file-system/abstract-file-system.interface";
import { NodeFileSystemService } from "./file-system/file-system.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EnvVariables, validate } from "./config/config.validator";

@Global()
@Module({
   providers: [
      {
         provide: LoggerToDb,
         scope: Scope.TRANSIENT,
         inject: [DataSource, INQUIRER],
         useFactory: (dataSource: DataSource, parentClass: object) => {
            return new LoggerToDb(parentClass?.constructor.name ?? "UnknownSource", dataSource.getRepository(Log));
         },
      },
      {
         provide: AbstractFileSystem,
         useClass: NodeFileSystemService,
      },
   ],
   exports: [LoggerToDb, AbstractFileSystem],
})
export class GlobalUtilityModule {}

@Module({
   imports: [
      GlobalUtilityModule,
      ConfigModule.forRoot({
         envFilePath: [".env.local"],
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
               entities: ["dist/models/**/*{.ts,.js}"],
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
      ThrottlerModule.forRoot({
         ttl: 30,
         limit: 1000,
      }),
      FilesModule,
      DirectoriesModule,
      TempUrlModule,
      AdminModule,
      UserProfileModule,
      CacheModule.registerAsync({
         useFactory: (config: ConfigService<EnvVariables>) => {
            return {
               store: redisStore,
               host: config.get("REDIS_HOST"),
               port: Number(config.get("REDIS_PORT")),
               password: config.get("REDIS_PASSWORD"),
               isGlobal: true,
               ttl: 1000 * 20, // 20 seconds
            };
         },
         inject: [ConfigService],
         isGlobal: true,
      }),
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

export function isDev(config: ConfigService<EnvVariables>) {
   return config.get("ENV") == "dev" || config.get("ENV") == "development";
}
