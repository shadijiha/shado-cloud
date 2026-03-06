import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthClientService, AuthUserDto } from "./auth-client.service";

/**
 * Guard that verifies the auth cookie via the auth microservice.
 * On success, attaches the verified user to `req.authUser`.
 *
 * Usage:
 *   @UseGuards(AuthGuardService)
 *   myRoute(@AuthedUserId() userId: string) { ... }
 */
@Injectable()
export class AuthGuardService implements CanActivate {
   constructor(
      private readonly authClient: AuthClientService,
      private readonly config: ConfigService<EnvVariables>,
   ) {}

   async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest();
      const token = req.cookies?.[this.config.get("COOKIE_NAME")];
      if (!token) throw new UnauthorizedException("Not authenticated");

      const result = await this.authClient.verify(token).catch(() => null);
      if (!result?.valid || !result.user) throw new UnauthorizedException(result?.error || "Invalid token");

      req.authUser = result.user;
      return true;
   }
}
