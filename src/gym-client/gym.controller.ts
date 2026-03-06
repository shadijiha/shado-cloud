import { All, Controller, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { type Request, type Response } from "express";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

@Controller("gym")
@ApiTags("Gym — proxied to shado-gym-api")
export class GymController {
   private readonly gymBaseUrl: string;

   constructor(private readonly config: ConfigService<EnvVariables>) {
      const host = config.get("GYM_SERVICE_HOST") || "localhost";
      const port = config.get("GYM_API_PORT") || 10001;
      this.gymBaseUrl = `http://${host}:${port}`;
   }

   @All("*path")
   async proxy(@Req() req: Request, @Res() res: Response) {
      const gymPath = req.url.replace(/^\/gym/, "");

      try {
         const upstream = await fetch(`${this.gymBaseUrl}${gymPath}`, {
            method: req.method,
            headers: {
               "Content-Type": "application/json",
               ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
            },
            body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
         });

         const contentType = upstream.headers.get("content-type") || "";

         if (!contentType.includes("application/json")) {
            const buf = Buffer.from(await upstream.arrayBuffer());
            for (const [key, val] of upstream.headers.entries()) {
               if (!["transfer-encoding", "connection"].includes(key)) res.setHeader(key, val);
            }
            return res.status(upstream.status).end(buf);
         }

         return res.status(upstream.status).json(await upstream.json());
      } catch {
         return res.status(502).json({ error: "Gym service unavailable" });
      }
   }
}
