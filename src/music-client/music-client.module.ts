import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { MusicController } from "./music.controller";
import { MUSIC_SERVICE } from "./constants";

@Module({
   imports: [
      ClientsModule.registerAsync([
         {
            name: MUSIC_SERVICE,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService<EnvVariables>) => ({
               transport: Transport.TCP,
               options: {
                  host: config.get("MUSIC_SERVICE_HOST") || "localhost",
                  port: Number(config.get("MUSIC_API_PORT")) || 9001,
               },
            }),
         },
      ]),
   ],
   controllers: [MusicController],
})
export class MusicClientModule {}
