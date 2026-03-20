import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { firstValueFrom } from "rxjs";
import { EnvVariables } from "./config/config.validator";
import { TrafficService } from "./traffic.service";

const METRICS_SERVICE = "METRICS_SERVICE";
export { METRICS_SERVICE };

/**
 * Periodically pushes metrics to shado-metrics via TCP.
 * Tracks: request_count, fs_bytes_read, fs_bytes_written, db_queries, db_avg_query_ms.
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

   // DB counters — incremented by wrapped DataSource.query
   private dbQueries = 0;
   private totalQueryTimeMs = 0;
   private lastDbQueries = 0;
   private lastQueryTimeMs = 0;
   private cacheHits = 0;
   private lastCacheHits = 0;

   constructor(
      @Inject(METRICS_SERVICE) private readonly metricsClient: ClientProxy,
      private readonly config: ConfigService<EnvVariables>,
      private readonly traffic: TrafficService,
      private readonly dataSource: DataSource,
   ) {
      this.serviceKey = this.config.get("SERVICE_SECRET");
   }

   onModuleInit() {
      // Wrap DataSource.query to track count + timing
      const origQuery = this.dataSource.query.bind(this.dataSource);
      this.dataSource.query = async (...args: any[]) => {
         const start = performance.now();
         const result = await origQuery(...args);
         this.totalQueryTimeMs += performance.now() - start;
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
      const stats = this.traffic.getStats();

      const requestDelta = stats.totalRequests - this.lastRequestCount;
      this.lastRequestCount = stats.totalRequests;

      const readDelta = this.fsBytesRead - this.lastFsBytesRead;
      const writeDelta = this.fsBytesWritten - this.lastFsBytesWritten;
      this.lastFsBytesRead = this.fsBytesRead;
      this.lastFsBytesWritten = this.fsBytesWritten;

      const dbDelta = this.dbQueries - this.lastDbQueries;
      this.lastDbQueries = this.dbQueries;

      const timeDelta = this.totalQueryTimeMs - this.lastQueryTimeMs;
      this.lastQueryTimeMs = this.totalQueryTimeMs;
      const avgQueryMs = dbDelta > 0 ? Math.round((timeDelta / dbDelta) * 100) / 100 : 0;

      const cacheDelta = this.cacheHits - this.lastCacheHits;
      this.lastCacheHits = this.cacheHits;

      try {
         await firstValueFrom(
            this.metricsClient.send("metrics.put", {
               serviceKey: this.serviceKey,
               datapoints: [
                  { namespace: "shado-cloud", metric: "request_count", value: requestDelta, unit: "Count", timestamp: now },
                  { namespace: "shado-cloud", metric: "fs_bytes_read", value: readDelta, unit: "Bytes", timestamp: now },
                  { namespace: "shado-cloud", metric: "fs_bytes_written", value: writeDelta, unit: "Bytes", timestamp: now },
                  { namespace: "shado-cloud", metric: "db_queries", value: dbDelta, unit: "Count", timestamp: now },
                  { namespace: "shado-cloud", metric: "db_avg_query_ms", value: avgQueryMs, unit: "Milliseconds", timestamp: now },
                  { namespace: "shado-cloud", metric: "db_cache_hits", value: cacheDelta, unit: "Count", timestamp: now },
               ],
            }),
         );
      } catch (err) {
         this.logger.warn(`Failed to push metrics to shado-metrics: ${(err as Error).message}`);
      }
   }
}
