import { Global, Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./auth.guard";
import { AUTH_SERVICE } from "./auth.constants";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./../models/user";
import { UploadedFile } from "./../models/uploadedFile";
import { SearchStat } from "./../models/stats/searchStat";
import { FileAccessStat } from "./../models/stats/fileAccessStat";
import { TempUrl } from "./../models/tempUrl";
import { AuthTrafficService } from "./auth-traffic.service";

@Global()
@Module({
   imports: [
      ClientsModule.registerAsync([
         {
            name: AUTH_SERVICE,
            useFactory: (config: ConfigService<EnvVariables>) => ({
               transport: Transport.TCP,
               options: {
                  host: config.get("cross-service.auth-api.host", { infer: true }),
                  port: config.get("cross-service.auth-api.port.tcp", { infer: true }) ?? 11002,
               },
            }),
            inject: [ConfigService],
         },
      ]),
      TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl]),
   ],
   providers: [AuthService, JwtAuthGuard, AuthTrafficService],
   exports: [AuthService, JwtAuthGuard, AuthTrafficService, ClientsModule, TypeOrmModule.forFeature([User, UploadedFile, SearchStat, FileAccessStat, TempUrl])],
})
export class AuthModule {}
