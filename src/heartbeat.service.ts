import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";
import { TrafficService } from "./traffic.service";

@Injectable()
export class HeartbeatService {
   private readonly logger = new Logger(HeartbeatService.name);

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly traffic: TrafficService,
   ) {}

   @Cron(CronExpression.EVERY_30_SECONDS)
   async beat() {
      const host = this.config.get("METRICS_HOST");
      if (!host) return;

      try {
         await fetch(`${host}/microservices/heartbeat`, {
            method: "POST",
            headers: {
               "Content-Type": "application/json",
               "x-service-key": this.config.get("SERVICE_SECRET"),
            },
            body: JSON.stringify({
               name: "shado-cloud-backend",
               port: Number(this.config.get("APP_PORT") ?? 9000),
               traffic: this.traffic.getStats(),
            }),
         });
      } catch {
         this.logger.warn("Heartbeat to shado-metrics failed");
      }
   }
}
