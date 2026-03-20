import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";

/**
 * Forwards raw cookies to auth-api for validation,
 * resolves to local User, attaches numeric userId to request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
   constructor(private readonly authService: AuthService) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const request = ctx.switchToHttp().getRequest();
      const cookies = request.headers.cookie;
      if (!cookies) throw new UnauthorizedException();

      const shadoUserId = await this.authService.validateCookies(cookies);
      if (!shadoUserId) throw new UnauthorizedException();

      const user = await this.authService.getUser(shadoUserId);
      if (!user) throw new UnauthorizedException();

      // Downstream gets numeric userId for DB relations
      request.authUserId = user.id;
      return true;
   }
}
