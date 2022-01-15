import { Module } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { DirectoriesController } from "./directories.controller";
import { DirectoriesService } from "./directories.service";

@Module({
	controllers: [DirectoriesController],
	providers: [DirectoriesService, AuthService, FilesService],
})
export class DirectoriesModule {}
