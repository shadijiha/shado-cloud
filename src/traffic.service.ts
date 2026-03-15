import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE } from "./util";

interface TrafficRecord {
   requests: number;
   bytesSent: number;
   bytesReceived: number;
}

@Injectable()
export class TrafficService implements OnModuleInit {
   private traffic = new Map<string, TrafficRecord>();
   private totalRequests = 0;
   private totalBytesSent = 0;
   private totalBytesReceived = 0;
   private since = new Date();
   private readonly redisKey = "traffic:shado-cloud-backend";

   constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

   async onModuleInit() {
      const raw = await this.redis.get(this.redisKey);
      if (raw) {
         const data = JSON.parse(raw);
         this.totalRequests = data.totalRequests ?? 0;
         this.totalBytesSent = data.totalBytesSent ?? 0;
         this.totalBytesReceived = data.totalBytesReceived ?? 0;
         this.since = new Date(data.since ?? Date.now());
         for (const [pattern, rec] of Object.entries(data.byPattern ?? {})) {
            this.traffic.set(pattern, rec as TrafficRecord);
         }
      }
   }

   record(pattern: string, bytesReceived: number, bytesSent: number) {
      const rec = this.traffic.get(pattern) ?? { requests: 0, bytesSent: 0, bytesReceived: 0 };
      rec.requests++;
      rec.bytesSent += bytesSent;
      rec.bytesReceived += bytesReceived;
      this.traffic.set(pattern, rec);

      this.totalRequests++;
      this.totalBytesSent += bytesSent;
      this.totalBytesReceived += bytesReceived;

      this.persist();
   }

   getStats() {
      const byPattern: Record<string, TrafficRecord> = {};
      for (const [pattern, rec] of this.traffic) {
         byPattern[pattern] = { ...rec };
      }
      return {
         since: this.since.toISOString(),
         totalRequests: this.totalRequests,
         totalBytesSent: this.totalBytesSent,
         totalBytesReceived: this.totalBytesReceived,
         totalBytes: this.totalBytesSent + this.totalBytesReceived,
         byPattern,
      };
   }

   private async persist() {
      await this.redis.set(this.redisKey, JSON.stringify(this.getStats())).catch(() => {});
   }
}
