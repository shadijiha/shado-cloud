import { ForbiddenException, Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

@Injectable()
export class LocalNetworkMiddleware implements NestMiddleware {
   constructor(private readonly featureFlagService: FeatureFlagService) {}

   async use(req: Request, res: Response, next: NextFunction) {
      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Replication, "replication")) {
         throw new ForbiddenException("Replication is disabled");
      }

      const ip = req.ip || req.socket.remoteAddress;
      if (this.isLocalNetwork(ip)) {
         next();
      } else {
         throw new ForbiddenException("Access is allowed only from local network");
      }
   }

   isLocalNetwork(ip: string): boolean {
      ip = ip.replace("::ffff:", "");
      return (
         ip.startsWith("192.168.") ||
         ip.startsWith("10.") ||
         (ip.startsWith("172.") && parseInt(ip.split(".")[1]) >= 16 && parseInt(ip.split(".")[1]) <= 31)
      );
   }
}
