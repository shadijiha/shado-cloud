import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { DirectoriesService } from "./../directories/directories.service";
import { FilesService } from "./../files/files.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthStrategy } from "./auth.strategy";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./../models/user";
import { UploadedFile } from "./../models/uploadedFile";
import { LoggerToDb } from "./../logging";
import { SearchStat } from "./../models/stats/searchStat";
import { FileAccessStat } from "./../models/stats/fileAccessStat";
import { TempUrl } from "./../models/tempUrl";

@Module({
    controllers: [AuthController],
    imports: [
        JwtModule.register({
            secret: process.env.JWT_SECRET,
            signOptions: {
                expiresIn: "24h",
            },
        }),
        TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl]),
    ],
    providers: [AuthStrategy, AuthService, FilesService, DirectoriesService],
    exports: [AuthService, TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl])],
})
export class AuthModule {}
