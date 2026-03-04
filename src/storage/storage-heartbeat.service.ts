import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";

@Injectable()
export class StorageHeartbeatService implements OnModuleInit {
   private readonly logger = new Logger(StorageHeartbeatService.name);
   private readonly port: number;
   private readonly heartbeatUrl: string;
   private readonly serviceKey: string;

   constructor(private readonly config: ConfigService<EnvVariables>) {
      this.port = Number(config.get("STORAGE_SERVICE_PORT") ?? 9002);
      const backendHost = config.get("BACKEND_HOST") ?? "http://127.0.0.1:9000";
      this.heartbeatUrl = `${backendHost}/admin/microservice/heartbeat`;
      this.serviceKey = config.get("JWT_SECRET");
   }

   onModuleInit() {
      this.sendHeartbeat();
   }

   @Interval(30_000)
   async sendHeartbeat() {
      try {
         await fetch(this.heartbeatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-service-key": this.serviceKey },
            body: JSON.stringify({ name: "storage", port: this.port }),
         });
      } catch (e) {
         this.logger.warn(`Heartbeat failed: ${(e as Error).message}`);
      }
   }
}
