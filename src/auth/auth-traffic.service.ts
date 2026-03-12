import { Injectable } from "@nestjs/common";

export interface TrafficRecord {
   requests: number;
   bytesSent: number;
   bytesReceived: number;
}

@Injectable()
export class AuthTrafficService {
   private traffic = new Map<string, TrafficRecord>();
   private totalRequests = 0;
   private totalBytesSent = 0;
   private totalBytesReceived = 0;
   private startedAt = new Date();

   record(pattern: string, payload: any, response: any) {
      const sent = Buffer.byteLength(JSON.stringify(payload));
      const received = Buffer.byteLength(JSON.stringify(response ?? ""));

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
         since: this.startedAt,
         totalRequests: this.totalRequests,
         totalBytesSent: this.totalBytesSent,
         totalBytesReceived: this.totalBytesReceived,
         totalBytes: this.totalBytesSent + this.totalBytesReceived,
         byPattern,
      };
   }
}
