import { Module } from "@nestjs/common";
import { DirectoriesService } from "./../directories/directories.service";
import { FilesService } from "./../files/files.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./../models/user";
import { UploadedFile } from "./../models/uploadedFile";
import { SearchStat } from "./../models/stats/searchStat";
import { FileAccessStat } from "./../models/stats/fileAccessStat";
import { TempUrl } from "./../models/tempUrl";

@Module({
   controllers: [AuthController],
   imports: [
      TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl]),
   ],
   providers: [AuthService, FilesService, DirectoriesService],
   exports: [AuthService, TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl])],
})
export class AuthModule {}
