import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { EnvVariables } from "./config/config.validator";
import { TrafficService } from "./traffic.service";

const METRICS_SERVICE = "METRICS_SERVICE";
export { METRICS_SERVICE };

/**
 * Periodically pushes metrics to shado-metrics via TCP.
 * Tracks: request_count, fs_bytes_read, fs_bytes_written (as deltas per flush).
 */
@Injectable()
export class MetricsPusherService implements OnModuleInit {
   private readonly logger = new Logger(MetricsPusherService.name);
   private readonly serviceKey: string;
   private lastRequestCount = 0;

   // FS byte counters — incremented by the instrumented file system
   public fsBytesRead = 0;
   public fsBytesWritten = 0;
   private lastFsBytesRead = 0;
   private lastFsBytesWritten = 0;

   constructor(
      @Inject(METRICS_SERVICE) private readonly metricsClient: ClientProxy,
      private readonly config: ConfigService<EnvVariables>,
      private readonly traffic: TrafficService,
   ) {
      this.serviceKey = this.config.get("SERVICE_SECRET");
   }

   onModuleInit() {
      setInterval(() => this.flush(), 15_000);
   }

   private async flush() {
      const now = new Date().toISOString();
      const stats = this.traffic.getStats();

      const requestDelta = stats.totalRequests - this.lastRequestCount;
      this.lastRequestCount = stats.totalRequests;

      const readDelta = this.fsBytesRead - this.lastFsBytesRead;
      const writeDelta = this.fsBytesWritten - this.lastFsBytesWritten;
      this.lastFsBytesRead = this.fsBytesRead;
      this.lastFsBytesWritten = this.fsBytesWritten;

      try {
         await firstValueFrom(
            this.metricsClient.send("metrics.put", {
               serviceKey: this.serviceKey,
               datapoints: [
                  { namespace: "shado-cloud", metric: "request_count", value: requestDelta, unit: "Count", timestamp: now },
                  { namespace: "shado-cloud", metric: "fs_bytes_read", value: readDelta, unit: "Bytes", timestamp: now },
                  { namespace: "shado-cloud", metric: "fs_bytes_written", value: writeDelta, unit: "Bytes", timestamp: now },
               ],
            }),
         );
      } catch {
         this.logger.warn("Failed to push metrics to shado-metrics");
      }
   }
}
