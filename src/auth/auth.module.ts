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
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

@Module({
   controllers: [AuthController],
   imports: [
      JwtModule.registerAsync({
         useFactory: (config: ConfigService<EnvVariables>) => {
            return {
               secret: config.get("JWT_SECRET"),
               signOptions: {
                  expiresIn: `${AuthController.AUTH_EXPIRY_DAYS}d`,
               },
            };
         },
         inject: [ConfigService],
      }),
      TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl]),
   ],
   providers: [AuthStrategy, AuthService, FilesService, DirectoriesService],
   exports: [AuthService, TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl])],
})
export class AuthModule {}
