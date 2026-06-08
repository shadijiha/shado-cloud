import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";

/**
 * Allows a request when it carries a valid `x-service-key` header matching the
 * shared cross-service secret. Used for trusted service-to-service calls
 * (e.g. shado-auth-api reading a feature flag) without an admin session.
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
   constructor(private readonly config: ConfigService<EnvVariables>) {}

   canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const key = req.headers["x-service-key"];
      const expected = this.config.get("cross-service.secret", { infer: true });
      return !!expected && key === expected;
   }
}
