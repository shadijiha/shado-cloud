import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthService } from "src/auth/auth.service";

@Injectable()
export class AdminGuard implements CanActivate {
   public constructor(
      private readonly authService: AuthService,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const request = ctx.switchToHttp().getRequest();
      const token = request.cookies?.[this.config.get<string>("COOKIE_NAME")];
      if (!token) return false;

      const userId = await this.authService.validateToken(token);
      if (!userId) return false;

      // Attach userId for @AuthUser()
      request.authUserId = userId;

      return this.authService.isAdmin(userId);
   }
}
