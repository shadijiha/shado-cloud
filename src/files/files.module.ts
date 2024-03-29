import { Module } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { DirectoriesService } from "src/directories/directories.service";
import { FilesConstoller } from "./files.controller";
import { FilesService } from "./files.service";

@Module({
	controllers: [FilesConstoller],
	providers: [FilesService, AuthService],
})
export class FilesModule {}
