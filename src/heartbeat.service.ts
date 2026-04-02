import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";
import { TrafficService } from "./traffic.service";
import { isDev } from "./util";

@Injectable()
export class HeartbeatService {
   private readonly logger = new Logger(HeartbeatService.name);

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly traffic: TrafficService,
   ) {}

   @Cron(CronExpression.EVERY_30_SECONDS)
   async beat() {
      const host = this.config.get("cross-service.metrics-api.host", { infer: true });
      if (!host) return;

      const port = this.config.get("cross-service.metrics-api.port.http", { infer: true });
      const protocol = isDev(this.config) ? "http" : "https";
      const fullUrl = `${protocol}://${host}${port ? ":" + port : ""}`

      try {
         await fetch(`${fullUrl}/microservices/heartbeat`, {
            method: "POST",
            headers: {
               "Content-Type": "application/json",
               "x-service-key": this.config.get("cross-service.secret", { infer: true }),
            },
            body: JSON.stringify({
               name: "shado-cloud-backend",
               port: this.config.get("this-service.port.http", { infer: true }) ?? 9000,
               traffic: this.traffic.getStats(),
            }),
         });
      } catch(e) {
         this.logger.warn(`Heartbeat to shado-metrics (${fullUrl}) failed: ${(e as Error).message}`);
      }
   }
}
