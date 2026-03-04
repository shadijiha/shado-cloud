import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

/**
 * Guard for internal service-to-service calls.
 * Validates the x-service-key header against JWT_SECRET.
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
   constructor(private readonly config: ConfigService<EnvVariables>) {}

   canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const key = req.headers["x-service-key"];
      if (key !== this.config.get("JWT_SECRET")) {
         throw new UnauthorizedException();
      }
      return true;
   }
}
