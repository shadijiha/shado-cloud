import { ForbiddenException, Injectable, NestMiddleware, Optional } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { LoggerToDb } from "src/logging";
import { normalizeIp, resolveClientIp } from "./client-ip.util";

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

      const ip = resolveClientIp(req);

      // The only IPs allowed in — stored in the replication feature flag payload.
      let allowedIps: string[] = [];
      if (this.featureFlagService) {
         ({ allowedIps } = await this.featureFlagService.getPayload(
            FeatureFlagNamespace.Replication,
            "replication",
            { allowedIps: [] as string[] },
         ));
      }
      const isAllowListed = allowedIps.some((allowed) => normalizeIp(allowed) === ip);

      if (isAllowListed) {
         next();
      } else {
         if (this.logger) void this.logger.debug(`Refused connection from ${ip}`);
         throw new ForbiddenException("Access is allowed only from an allow-listed IP");
      }
   }
}
