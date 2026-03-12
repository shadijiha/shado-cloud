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
      // NestJS TCP transport wraps messages as: <JSON>{"pattern":"...","data":...,"id":"..."}\n
      // Estimate wire bytes by including the framing overhead
      const payloadJson = JSON.stringify(payload);
      const responseJson = JSON.stringify(response ?? "");
      const id = '"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"'; // 38 chars, UUID placeholder
      const sent = Buffer.byteLength(`{"pattern":"${pattern}","data":${payloadJson},"id":${id}}`) + 1; // +1 for delimiter
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
         since: this.startedAt,
         totalRequests: this.totalRequests,
         totalBytesSent: this.totalBytesSent,
         totalBytesReceived: this.totalBytesReceived,
         totalBytes: this.totalBytesSent + this.totalBytesReceived,
         byPattern,
      };
   }
}
