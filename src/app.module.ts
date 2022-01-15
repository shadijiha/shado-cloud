import { Logger, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./auth/auth.module";
import { FilesModule } from "./files/files.module";
import { DirectoriesModule } from "./directories/directories.module";
import { TempUrlModule } from "./temp-url/temp-url.module";

@Module({
	imports: [
		AuthModule,
		TypeOrmModule.forRoot({
			type: process.env.DB_TYPE as any,
			host: process.env.DB_HOST,
			port: Number(process.env.DB_PORT),
			username: process.env.DB_USERNAME,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
			entities: ["dist/models/*{.ts,.js}"],
			synchronize: isDev(),
		}),
		FilesModule,
		DirectoriesModule,
		TempUrlModule,
	],
	controllers: [AppController],
	providers: [AppService],
})
export class AppModule {}

function isDev() {
	return true;
	//return process.env.ENV == "dev";
}