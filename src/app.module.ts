import { Module } from "@nestjs/common";
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
import { APP_GUARD } from "@nestjs/core";

@Module({
	imports: [
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
			// cache: {
			// 	type: "redis",
			// 	duration: 1000, // 1 second
			// 	options: {
			// 		host: process.env.REDIS_HOST,
			// 		port: Number(process.env.REDIS_PORT),
			// 		password: process.env.REDIS_PASSWORD,
			// 	},
			// 	alwaysEnabled: true,
			// },
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
export class AppModule {}

function isDev() {
	return process.env.ENV == "dev";
}
