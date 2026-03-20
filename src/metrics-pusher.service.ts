import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { firstValueFrom } from "rxjs";
import { EnvVariables } from "./config/config.validator";

const METRICS_SERVICE = "METRICS_SERVICE";
export { METRICS_SERVICE };

/**
 * Periodically pushes metrics to shado-metrics via TCP.
 * All counters reset on each flush — no delta tracking needed.
 */
@Injectable()
export class MetricsPusherService implements OnApplicationBootstrap {
   private readonly logger = new Logger(MetricsPusherService.name);
   private readonly serviceKey: string;

   // Counters — reset on each flush
   public requestCount = 0;
   public fsBytesRead = 0;
   public fsBytesWritten = 0;
   private dbQueries = 0;
   private cacheHits = 0;
   private queryTimings: number[] = [];

   constructor(
      @Inject(METRICS_SERVICE) private readonly metricsClient: ClientProxy,
      private readonly config: ConfigService<EnvVariables>,
      private readonly dataSource: DataSource,
   ) {
      this.serviceKey = this.config.get("SERVICE_SECRET");
   }

   /** Called by TrafficMiddleware on every request */
   recordRequest() {
      this.requestCount++;
   }

   onApplicationBootstrap() {
      // Wrap DataSource.query to track count + timing
      const origQuery = this.dataSource.query.bind(this.dataSource);
      this.dataSource.query = async (...args: any[]) => {
         const start = performance.now();
         const result = await origQuery(...args);
         this.queryTimings.push(Math.round((performance.now() - start) * 100) / 100);
         this.dbQueries++;
         return result;
      };

      // Wrap QueryResultCache.getFromCache to track cache hits
      const cache = (this.dataSource as any).queryResultCache;
      if (cache) {
         const origGet = cache.getFromCache.bind(cache);
         cache.getFromCache = async (...args: any[]) => {
            const result = await origGet(...args);
            if (result) this.cacheHits++;
            return result;
         };
      }

      setInterval(() => this.flush(), 15_000);
   }

   private async flush() {
      const now = new Date().toISOString();

      // Drain all counters
      const requests = this.requestCount;
      const readBytes = this.fsBytesRead;
      const writeBytes = this.fsBytesWritten;
      const queries = this.dbQueries;
      const cacheHits = this.cacheHits;
      const timings = this.queryTimings.splice(0);

      this.requestCount = 0;
      this.fsBytesRead = 0;
      this.fsBytesWritten = 0;
      this.dbQueries = 0;
      this.cacheHits = 0;

      const datapoints: any[] = [
         { namespace: "shado-cloud", metric: "request_count", value: requests, unit: "Count", timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_read", value: readBytes, unit: "Bytes", timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_written", value: writeBytes, unit: "Bytes", timestamp: now },
         { namespace: "shado-cloud", metric: "db_queries", value: queries, unit: "Count", timestamp: now },
         { namespace: "shado-cloud", metric: "db_cache_hits", value: cacheHits, unit: "Count", timestamp: now },
         ...timings.map(ms => ({ namespace: "shado-cloud", metric: "db_query_ms", value: ms, unit: "Milliseconds", timestamp: now })),
      ];

      try {
         await firstValueFrom(
            this.metricsClient.send("metrics.put", {
               serviceKey: this.serviceKey,
               datapoints,
            }),
         );
      } catch (err) {
         this.logger.warn(`Failed to push metrics to shado-metrics: ${(err as Error).message}`);
      }
   }
}
