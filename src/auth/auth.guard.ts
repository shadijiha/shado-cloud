import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthService } from "./auth.service";

/**
 * Replaces @UseGuards(JwtAuthGuard).
 * Extracts the cookie, validates via auth microservice, attaches userId to request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
   constructor(
      private readonly authService: AuthService,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const request = ctx.switchToHttp().getRequest();
      const token = request.cookies?.[this.config.get("COOKIE_NAME")];
      if (!token) throw new UnauthorizedException();

      const userId = await this.authService.validateToken(token);
      if (!userId) throw new UnauthorizedException();

      // Attach userId so @AuthUser() can read it
      request.authUserId = userId;
      return true;
   }
}
