import { Module } from "@nestjs/common";
import { AuthService } from "./../auth/auth.service";
import { FilesService } from "./../files/files.service";
import { DirectoriesController } from "./directories.controller";
import { DirectoriesService } from "./directories.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UploadedFile } from "./../models/uploadedFile";
import { User } from "./../models/user";
import { FilesModule } from "src/files/files.module";
import { AuthModule } from "src/auth/auth.module";

@Module({
	imports: [FilesModule, AuthModule],
	controllers: [DirectoriesController],
	providers: [DirectoriesService],
	exports: [DirectoriesService],
})
export class DirectoriesModule {}
