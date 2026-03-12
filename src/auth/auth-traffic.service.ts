import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";

export interface TrafficRecord {
   requests: number;
   bytesSent: number;
   bytesReceived: number;
}

const REDIS_KEY = "auth-traffic:stats";

@Injectable()
export class AuthTrafficService implements OnModuleInit {
   private traffic = new Map<string, TrafficRecord>();
   private totalRequests = 0;
   private totalBytesSent = 0;
   private totalBytesReceived = 0;
   private since = new Date();

   constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

   async onModuleInit() {
      const raw = await this.redis.get(REDIS_KEY);
      if (raw) {
         const data = JSON.parse(raw);
         this.totalRequests = data.totalRequests ?? 0;
         this.totalBytesSent = data.totalBytesSent ?? 0;
         this.totalBytesReceived = data.totalBytesReceived ?? 0;
         this.since = new Date(data.since ?? Date.now());
         for (const [pattern, rec] of Object.entries(data.byPattern ?? {})) {
            this.traffic.set(pattern, rec as TrafficRecord);
         }
      } else {
         this.since = new Date();
         await this.persist();
      }
   }

   record(pattern: string, payload: any, response: any) {
      // NestJS TCP transport wraps messages as: <JSON>{"pattern":"...","data":...,"id":"..."}\n
      // Estimate wire bytes by including the framing overhead
      const payloadJson = JSON.stringify(payload);
      const responseJson = JSON.stringify(response ?? "");
      const id = '"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"';
      const sent = Buffer.byteLength(`{"pattern":"${pattern}","data":${payloadJson},"id":${id}}`) + 1;
      const received = Buffer.byteLength(`{"response":${responseJson},"isDisposed":false,"id":${id}}`) + 1;

      const rec = this.traffic.get(pattern) ?? { requests: 0, bytesSent: 0, bytesReceived: 0 };
      rec.requests++;
      rec.bytesSent += sent;
      rec.bytesReceived += received;
      this.traffic.set(pattern, rec);

      this.totalRequests++;
      this.totalBytesSent += sent;
      this.totalBytesReceived += received;
   }

   getStats() {
      const byPattern: Record<string, TrafficRecord> = {};
      for (const [pattern, rec] of this.traffic) {
         byPattern[pattern] = { ...rec };
      }
      return {
         since: this.since,
         totalRequests: this.totalRequests,
         totalBytesSent: this.totalBytesSent,
         totalBytesReceived: this.totalBytesReceived,
         totalBytes: this.totalBytesSent + this.totalBytesReceived,
         byPattern,
      };
   }

   @Cron(CronExpression.EVERY_MINUTE)
   async persist() {
      const byPattern: Record<string, TrafficRecord> = {};
      for (const [pattern, rec] of this.traffic) {
         byPattern[pattern] = { ...rec };
      }
      await this.redis.set(REDIS_KEY, JSON.stringify({
         since: this.since,
         totalRequests: this.totalRequests,
         totalBytesSent: this.totalBytesSent,
         totalBytesReceived: this.totalBytesReceived,
         byPattern,
      }));
   }
}
