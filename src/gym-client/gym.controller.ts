import { All, Controller, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { type Request, type Response } from "express";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { isDev } from "src/util";

const GYM_COOKIE = "gym_auth";
const GYM_AUTH_EXPIRY_DAYS = 180;

@Controller("gym")
@ApiTags("Gym — proxied to shado-gym-api")
export class GymController {
   private readonly gymBaseUrl: string;

   constructor(
      private readonly jwtService: JwtService,
      private readonly config: ConfigService<EnvVariables>,
   ) {
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

         // Binary responses (images etc)
         if (!contentType.includes("application/json")) {
            const buf = Buffer.from(await upstream.arrayBuffer());
            for (const [key, val] of upstream.headers.entries()) {
               if (!["transfer-encoding", "connection"].includes(key)) res.setHeader(key, val);
            }
            return res.status(upstream.status).end(buf);
         }

         const data = await upstream.json();

         // If this was a login/register, set the gym auth cookie from the response
         if (req.method === "POST" && /^\/auth\/(login|register)$/.test(gymPath.split("?")[0]) && data.id && !data.error) {
            this.setGymCookie(req, data, res);
         }

         // If this was a logout, clear the cookie
         if (req.method === "POST" && gymPath.split("?")[0] === "/auth/logout") {
            res.clearCookie(GYM_COOKIE, { httpOnly: true, domain: this.getDomain(req) });
         }

         return res.status(upstream.status).json(data);
      } catch {
         return res.status(502).json({ error: "Gym service unavailable" });
      }
   }

   private setGymCookie(req: Request, user: { id: string; email: string }, res: Response) {
      const token = this.jwtService.sign({ sub: user.id, email: user.email });
      res.cookie(GYM_COOKIE, token, {
         httpOnly: true,
         domain: this.getDomain(req),
         expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * GYM_AUTH_EXPIRY_DAYS),
         secure: isDev(this.config) ? false : req.headers.origin?.startsWith("https"),
         sameSite: isDev(this.config) ? "lax" : "none",
      });
   }

   private getDomain(req: Request): string {
      let domain = req.headers.host || "localhost";
      if (domain.includes(":")) domain = domain.split(":")[0];
      const parts = domain.split(".");
      if (parts.length > 2) domain = parts.slice(-2).join(".");
      return domain;
   }
}
