import { Inject, Injectable, NestMiddleware, Optional } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { TrafficService } from "./traffic.service";
import { MetricsPusherService } from "./metrics-pusher.service";

@Injectable()
export class TrafficMiddleware implements NestMiddleware {
   constructor(
      @Inject(TrafficService) private readonly traffic: TrafficService,
      @Optional() @Inject(MetricsPusherService) private readonly metricsPusher?: MetricsPusherService,
   ) {}

   use(req: Request, res: Response, next: NextFunction) {
      const start = performance.now();

      // Estimate incoming bytes: request line + headers + body
      let reqBytes = 0;
      for (const [key, val] of Object.entries(req.headers)) {
         reqBytes += Buffer.byteLength(`${key}: ${Array.isArray(val) ? val.join(", ") : val || ""}\r\n`);
      }
      reqBytes += Buffer.byteLength(`${req.method} ${req.originalUrl} HTTP/1.1\r\n`);
      reqBytes += Number(req.headers["content-length"] || 0);

      const pattern = `${req.method} ${req.baseUrl || ""}${req.path}`.replace(/\/[0-9a-f-]{20,}/gi, "/:id");

      const origWrite = res.write;
      const origEnd = res.end;
      let resBytes = 0;

      res.write = (...args: any[]) => {
         if (args[0]) resBytes += Buffer.byteLength(args[0]);
         return origWrite.apply(res, args);
      };

      res.end = (...args: any[]) => {
         if (args[0] && typeof args[0] !== "function") resBytes += Buffer.byteLength(args[0]);
         const durationMs = Math.round((performance.now() - start) * 100) / 100;
         this.traffic.record(pattern, reqBytes, resBytes);
         if (this.metricsPusher) {
            const ip = (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip || "unknown") as string;
            const ua = (req.headers["user-agent"] || "unknown").substring(0, 100);
            const origin = (req.headers["origin"] || req.headers["referer"] || "direct") as string;
            this.metricsPusher.recordRequestDetails(pattern, req.method, ip.split(",")[0].trim(), reqBytes, resBytes, ua, origin);
            this.metricsPusher.recordRequestDuration(durationMs, pattern);
         }
         return origEnd.apply(res, args);
      };

      next();
   }
}
