import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { StorageMicroserviceModule } from "./storage-microservice.module";
import { ConfigModule } from "@nestjs/config";

async function bootstrap() {
   await ConfigModule.envVariablesLoaded;

   const host = process.env.STORAGE_SERVICE_HOST ?? "127.0.0.1";
   const port = Number(process.env.STORAGE_SERVICE_PORT ?? 9002);

   const app = await NestFactory.createMicroservice<MicroserviceOptions>(StorageMicroserviceModule, {
      transport: Transport.TCP,
      options: { host, port },
   });

   await app.listen();
   console.log(`Storage microservice listening on ${host}:${port}`);
}
bootstrap();
