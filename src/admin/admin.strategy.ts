import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";

@Injectable()
export class AdminGuard implements CanActivate {
   public constructor(private readonly authService: AuthService) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const request = ctx.switchToHttp().getRequest();
      const cookies = request.headers.cookie;
      if (!cookies) return false;

      const shadoUserId = await this.authService.validateCookies(cookies);
      if (!shadoUserId) return false;

      const user = await this.authService.getUser(shadoUserId);
      if (!user) return false;

      request.authUserId = user.id;
      return this.authService.isAdmin(shadoUserId);
   }
}
