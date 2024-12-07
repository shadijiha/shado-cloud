import { Module } from "@nestjs/common";
import { AuthService } from "./../auth/auth.service";
import { FilesConstoller } from "./files.controller";
import { FilesService } from "./files.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UploadedFile } from "./../models/uploadedFile";
import { User } from "./../models/user";
import { AuthModule } from "src/auth/auth.module";

@Module({
	imports: [AuthModule],
	controllers: [FilesConstoller],
	providers: [FilesService],
	exports: [FilesService],
})
export class FilesModule {}
