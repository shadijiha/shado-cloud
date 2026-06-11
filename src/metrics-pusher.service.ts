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
   public requestBytesIn = 0;
   public requestBytesOut = 0;
   public fsBytesRead = 0;
   public fsBytesWritten = 0;
   // Filesystem operation metrics
   public fsReadOps = 0;
   public fsWriteOps = 0;
   private fsOpDurations: { ms: number; op: string }[] = [];
   // Cold-storage (dynamic filesystem) metrics
   public coldStoragePromotions = 0; // files moved from a cold drive back to the main drive
   public coldStorageAccesses = 0;   // file reads served from a cold drive
   public hotStorageAccesses = 0;    // file reads served from the main drive
   public coldStorageFileCount = 0;  // gauge: number of files currently parked on cold drives
   public coldStorageDemotions = 0;       // files moved main -> cold by the daily sweep
   public coldStorageBytesMoved = 0;      // bytes moved to cold by the daily sweep
   public coldStorageDemotionErrors = 0;  // files that failed to demote during the sweep
   public coldStorageIndexPruned = 0;     // index rows pruned by reconciliation (DB/disk drift)
   public coldStorageLastSweepMs = 0;     // gauge: wall-clock duration of the last demotion sweep
   private dbQueries = 0;
   private cacheHits = 0;
   private queryTimings: number[] = [];
   private requestRecords: { route: string; method: string; ip: string; bytesIn: number; bytesOut: number; userAgent: string; origin: string }[] = [];
   private requestDurations: { ms: number; route: string }[] = [];
   private unauthorizedRecords: { ip: string; route: string }[] = [];

   constructor(
      @Inject(METRICS_SERVICE) private readonly metricsClient: ClientProxy,
      private readonly config: ConfigService<EnvVariables>,
      private readonly dataSource: DataSource,
   ) {
      this.serviceKey = this.config.get("cross-service.secret", { infer: true });
   }

   recordRequestDetails(route: string, method: string, ip: string, bytesIn: number, bytesOut: number, userAgent: string, origin: string) {
      this.requestCount++;
      this.requestBytesIn += bytesIn;
      this.requestBytesOut += bytesOut;
      this.requestRecords.push({ route, method, ip, bytesIn, bytesOut, userAgent, origin });
   }

   recordRequestDuration(ms: number, route: string) {
      this.requestDurations.push({ ms, route });
   }

   recordUnauthorized(ip: string, route: string) {
      this.unauthorizedRecords.push({ ip, route });
   }

   /** Record the latency (ms) of a single filesystem operation and bump its read/write counter. */
   recordFsOp(op: string, ms: number, kind: "read" | "write" | "meta") {
      this.fsOpDurations.push({ op, ms });
      if (kind === "read") this.fsReadOps++;
      else if (kind === "write") this.fsWriteOps++;
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

      setInterval(() => { void this.flush(); }, 15_000);
   }

   private async flush() {
      const now = new Date().toISOString();

      // Drain all counters
      const requests = this.requestCount;
      const bytesIn = this.requestBytesIn;
      const bytesOut = this.requestBytesOut;
      const readBytes = this.fsBytesRead;
      const writeBytes = this.fsBytesWritten;
      const queries = this.dbQueries;
      const cacheHits = this.cacheHits;
      const timings = this.queryTimings.splice(0);
      const reqRecords = this.requestRecords.splice(0);
      const reqDurations = this.requestDurations.splice(0);
      const unauthorizedRecs = this.unauthorizedRecords.splice(0);
      const fsReadOps = this.fsReadOps;
      const fsWriteOps = this.fsWriteOps;
      const fsOpDurs = this.fsOpDurations.splice(0);
      const coldPromotions = this.coldStoragePromotions;
      const coldAccesses = this.coldStorageAccesses;
      const hotAccesses = this.hotStorageAccesses;
      const coldFileCount = this.coldStorageFileCount; // gauge — reported as-is, not reset
      const coldDemotions = this.coldStorageDemotions;
      const coldBytesMoved = this.coldStorageBytesMoved;
      const coldDemotionErrors = this.coldStorageDemotionErrors;
      const coldIndexPruned = this.coldStorageIndexPruned;
      const coldSweepMs = this.coldStorageLastSweepMs; // gauge — reported as-is, not reset

      this.requestCount = 0;
      this.requestBytesIn = 0;
      this.requestBytesOut = 0;
      this.fsBytesRead = 0;
      this.fsBytesWritten = 0;
      this.dbQueries = 0;
      this.cacheHits = 0;
      this.fsReadOps = 0;
      this.fsWriteOps = 0;
      this.coldStoragePromotions = 0;
      this.coldStorageAccesses = 0;
      this.hotStorageAccesses = 0;
      this.coldStorageDemotions = 0;
      this.coldStorageBytesMoved = 0;
      this.coldStorageDemotionErrors = 0;
      this.coldStorageIndexPruned = 0;

      const datapoints: any[] = [
         { namespace: "shado-cloud", metric: "request_count", value: requests, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "request_bytes_in", value: bytesIn, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "request_bytes_out", value: bytesOut, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_read", value: readBytes, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "fs_bytes_written", value: writeBytes, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "db_queries", value: queries, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "db_cache_hits", value: cacheHits, unit: MetricUnit.Count, timestamp: now },
         ...timings.map(ms => ({ namespace: "shado-cloud", metric: "db_query_ms", value: ms, unit: MetricUnit.Milliseconds, timestamp: now })),
         ...reqRecords.map(r => ({ namespace: "shado-cloud", metric: "request", value: 1, unit: MetricUnit.Count, dimensions: { route: r.route, method: r.method, ip: r.ip, user_agent: r.userAgent, origin: r.origin }, timestamp: now })),
         ...reqDurations.map(d => ({ namespace: "shado-cloud", metric: "request_duration_ms", value: d.ms, unit: MetricUnit.Milliseconds, dimensions: { route: d.route }, timestamp: now })),
         ...unauthorizedRecs.map(r => ({ namespace: "shado-cloud", metric: "unauthorized_errors", value: 1, unit: MetricUnit.Count, dimensions: { ip: r.ip, route: r.route }, timestamp: now })),
         { namespace: "shado-cloud", metric: "fs_read_ops", value: fsReadOps, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "fs_write_ops", value: fsWriteOps, unit: MetricUnit.Count, timestamp: now },
         ...fsOpDurs.map(d => ({ namespace: "shado-cloud", metric: "fs_op_ms", value: d.ms, unit: MetricUnit.Milliseconds, dimensions: { op: d.op }, timestamp: now })),
         { namespace: "shado-cloud", metric: "cold_storage_promotions", value: coldPromotions, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_accesses", value: coldAccesses, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "hot_storage_accesses", value: hotAccesses, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_file_count", value: coldFileCount, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_demotions", value: coldDemotions, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_bytes_moved", value: coldBytesMoved, unit: MetricUnit.Bytes, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_demotion_errors", value: coldDemotionErrors, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_index_pruned", value: coldIndexPruned, unit: MetricUnit.Count, timestamp: now },
         { namespace: "shado-cloud", metric: "cold_storage_demotion_sweep_ms", value: coldSweepMs, unit: MetricUnit.Milliseconds, timestamp: now },
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
