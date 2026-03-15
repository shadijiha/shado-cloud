import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { TrafficService } from "./traffic.service";

@Injectable()
export class TrafficMiddleware implements NestMiddleware {
   constructor(@Inject(TrafficService) private readonly traffic: TrafficService) {}

   use(req: Request, res: Response, next: NextFunction) {
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
         this.traffic.record(pattern, reqBytes, resBytes);
         return origEnd.apply(res, args);
      };

      next();
   }
}
