import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";
import { TrafficService } from "./traffic.service";
import { isDev } from "./util";
import { collectCronJobs } from "./admin/cron.service";

@Injectable()
export class HeartbeatService {
   private readonly logger = new Logger(HeartbeatService.name);

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly traffic: TrafficService,
      private readonly schedulerRegistry: SchedulerRegistry,
   ) {}

   @Cron(CronExpression.EVERY_30_SECONDS, { name: "heartbeat:beat" })
   async beat() {
      const host = this.config.get("cross-service.metrics-api.host", { infer: true });
      if (!host) return;

      const port = this.config.get("cross-service.metrics-api.port.http", { infer: true });
      const protocol = isDev(this.config) || host == "localhost" || host == "127.0.0.1" ? "http" : "https";
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
               crons: collectCronJobs(this.schedulerRegistry),
            }),
         });
      } catch(e) {
         this.logger.warn(`Heartbeat to shado-metrics (${fullUrl}) failed: ${(e as Error).message}`);
      }
   }
}
