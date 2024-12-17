import { Global, MiddlewareConsumer, Module, RequestMethod, Scope } from "@nestjs/common";
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
        RequestContextModule,
        AuthModule,
        TypeOrmModule.forRoot({
            type: process.env.DB_TYPE as any,
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            username: process.env.DB_USERNAME,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            entities: ["dist/models/**/*{.ts,.js}"],
            synchronize: isDev(),
            logging: false,
            // Only define cache if REDIS_HOST is defined in env
            cache: process.env.REDIS_HOST
                ? {
                      type: "redis",
                      duration: 1000, // 1 second
                      options: {
                          host: process.env.REDIS_HOST,
                          port: Number(process.env.REDIS_PORT),
                          password: process.env.REDIS_PASSWORD,
                      },
                      alwaysEnabled: true,
                  }
                : undefined,
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
        CacheModule.register({
            store: redisStore,
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT),
            password: process.env.REDIS_PASSWORD,
            isGlobal: true,
            ttl: 1000 * 20, // 20 seconds
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

export function isDev() {
    return process.env.ENV == "dev" || process.env.ENV == "development";
}
