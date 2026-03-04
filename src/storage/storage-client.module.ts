import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { STORAGE_SERVICE } from "./storage.patterns";
import { StorageClient } from "./storage.client";

@Module({
   imports: [
      ClientsModule.registerAsync([
         {
            name: STORAGE_SERVICE,
            useFactory: (config: ConfigService<EnvVariables>) => ({
               transport: Transport.TCP,
               options: {
                  host: config.get("STORAGE_SERVICE_HOST") ?? "127.0.0.1",
                  port: Number(config.get("STORAGE_SERVICE_PORT") ?? 9002),
               },
            }),
            inject: [ConfigService],
         },
      ]),
   ],
   providers: [StorageClient],
   exports: [StorageClient],
})
export class StorageClientModule {}
