import { Module } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { TempUrlConstoller } from "./tempUrl.controller";
import { TempUrlService } from "./tempUrl.service";

@Module({
	controllers: [TempUrlConstoller],
	providers: [TempUrlService, FilesService, AuthService],
})
export class TempUrlModule {}
