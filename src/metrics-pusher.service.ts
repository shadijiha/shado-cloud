import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { firstValueFrom } from "rxjs";
import { EnvVariables } from "./config/config.validator";

const METRICS_SERVICE = "METRICS_SERVICE";
export { METRICS_SERVICE };

export enum MetricUnit {
   Count = "Count",
   Bytes = "Bytes",
   Percent = "Percent",
   Milliseconds = "Milliseconds",
   None = "None",
}

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
      // Wrap QueryRunner.query — all TypeORM operations go through this
      const origCreateQueryRunner = this.dataSource.createQueryRunner.bind(this.dataSource);
      const self = this;
      this.dataSource.createQueryRunner = (...args: any[]) => {
         const qr = origCreateQueryRunner(...args);
         const origQuery = qr.query.bind(qr);
         qr.query = async (...qArgs: any[]) => {
            const start = performance.now();
            const result = await origQuery(...qArgs);
            self.queryTimings.push(Math.round((performance.now() - start) * 100) / 100);
            self.dbQueries++;
            return result;
         };
         return qr;
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
         { namespace: "shado-cloud", metric: "request_count", value: requests, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_read", value: readBytes, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_written", value: writeBytes, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "db_queries", value: queries, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "db_cache_hits", value: cacheHits, unit: MetricUnit.Count, timestamp: now },
         ...timings.map(ms => ({ namespace: "shado-cloud", metric: "db_query_ms", value: ms, unit: MetricUnit.Milliseconds, timestamp: now })),
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
