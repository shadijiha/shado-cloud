import { Module } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { TempUrlConstoller } from "./tempUrl.controller";
import { TempUrlService } from "./tempUrl.service";
import { AuthModule } from "src/auth/auth.module";
import { FilesModule } from "src/files/files.module";

@Module({
   imports: [AuthModule, FilesModule],
   controllers: [TempUrlConstoller],
   providers: [TempUrlService],
})
export class TempUrlModule {}
