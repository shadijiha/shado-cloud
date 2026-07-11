import { ForbiddenException, Injectable, NestMiddleware, Optional } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { LoggerToDb } from "src/logging";

@Injectable()
export class LocalNetworkMiddleware implements NestMiddleware {
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

      const ip = this.normalizeIp(req.ip || req.socket.remoteAddress);

      // Extra IPs allow-listed by an admin, stored in the replication feature flag payload
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
         throw new ForbiddenException("Access is allowed only from the local network or an allow-listed IP");
      }
   }

   private normalizeIp(ip?: string): string {
      return (ip ?? "").replace("::ffff:", "").trim();
   }

   /**
    * Unused. Kept here incase we need it in the future
    */
   private isLocalNetwork(ip: string): boolean {
      ip = ip.replace("::ffff:", "");
      return (
         ip.startsWith("192.168.") ||
         ip.startsWith("10.") ||
         (ip.startsWith("172.") && parseInt(ip.split(".")[1]) >= 16 && parseInt(ip.split(".")[1]) <= 31)
      );
   }
}
