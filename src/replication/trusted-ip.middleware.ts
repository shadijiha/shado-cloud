import { ForbiddenException, Injectable, NestMiddleware, Optional } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { LoggerToDb } from "src/logging";

/**
 * Guards the replication endpoints. Access is granted ONLY to IPs explicitly
 * allow-listed by an admin (stored in the replication feature flag payload).
 * There is no local-network bypass.
 */
@Injectable()
export class TrustedIpMiddleware implements NestMiddleware {
   constructor(
      @Optional() private readonly featureFlagService: FeatureFlagService,
      @Optional() private readonly logger: LoggerToDb,
   ) {}

   async use(req: Request, res: Response, next: NextFunction) {
      if (
         this.featureFlagService &&
         (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Replication, "replication"))
      ) {
         throw new ForbiddenException("Replication is disabled");
      }

      const ip = this.resolveClientIp(req);

      // The only IPs allowed in — stored in the replication feature flag payload.
      let allowedIps: string[] = [];
      if (this.featureFlagService) {
         ({ allowedIps } = await this.featureFlagService.getPayload(
            FeatureFlagNamespace.Replication,
            "replication",
            { allowedIps: [] as string[] },
         ));
      }
      const isAllowListed = allowedIps.some((allowed) => this.normalizeIp(allowed) === ip);

      if (isAllowListed) {
         next();
      } else {
         if (this.logger) void this.logger.debug(`Refused connection from ${ip}`);
         throw new ForbiddenException("Access is allowed only from an allow-listed IP");
      }
   }

   /**
    * Resolves the real client IP.
    *
    * Behind a Cloudflare tunnel, cloudflared runs on the same host and proxies to
    * the app on loopback, so req.socket.remoteAddress is always 127.0.0.1/::1 and
    * the true client IP is in the `CF-Connecting-IP` header. We only trust that
    * header when the socket is actually loopback (i.e. the request really came
    * from the local tunnel); otherwise a direct client could spoof it.
    */
   private resolveClientIp(req: Request): string {
      const socketIp = this.normalizeIp(req.socket.remoteAddress);
      const isFromLocalTunnel = socketIp === "127.0.0.1" || socketIp === "::1";
      const cfIp = req.headers["cf-connecting-ip"];
      if (isFromLocalTunnel && typeof cfIp === "string" && cfIp.trim()) {
         return this.normalizeIp(cfIp);
      }
      return this.normalizeIp(req.ip || req.socket.remoteAddress);
   }

   private normalizeIp(ip?: string): string {
      return (ip ?? "").replace("::ffff:", "").trim();
   }
}
