import { Global, Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { AUTH_SERVICE } from "./constants";
import { AuthClientService } from "./auth-client.service";
import { AuthGuardService } from "./auth.guard";

@Global()
@Module({
   imports: [
      ClientsModule.registerAsync([
         {
            name: AUTH_SERVICE,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService<EnvVariables>) => ({
               transport: Transport.TCP,
               options: {
                  host: config.get("AUTH_SERVICE_HOST") || "localhost",
                  port: Number(config.get("AUTH_API_PORT")) || 11001,
               },
            }),
         },
      ]),
   ],
   providers: [AuthClientService, AuthGuardService],
   exports: [AuthClientService, AuthGuardService],
})
export class AuthClientModule {}
