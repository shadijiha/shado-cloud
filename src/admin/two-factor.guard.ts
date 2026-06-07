import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "src/auth/auth.service";
import { REQUIRE_2FA_KEY, StepUpScope } from "./step-up.constants";

/**
 * Marks an endpoint as requiring a valid step-up 2FA grant for the given scope.
 * Use together with TwoFactorGuard, AFTER JwtAuthGuard + AdminGuard (which set
 * request.authUserId).
 *
 *   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
 *   @Require2fa("database")
 */
export const Require2fa = (scope: StepUpScope) => SetMetadata(REQUIRE_2FA_KEY, scope);

@Injectable()
export class TwoFactorGuard implements CanActivate {
   constructor(
      private readonly reflector: Reflector,
      private readonly authService: AuthService,
   ) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const scope = this.reflector.getAllAndOverride<StepUpScope | undefined>(REQUIRE_2FA_KEY, [
         ctx.getHandler(),
         ctx.getClass(),
      ]);
      if (!scope) return true; // endpoint doesn't require step-up

      const request = ctx.switchToHttp().getRequest();
      const localUserId = request.authUserId;
      if (!localUserId || localUserId === -1) {
         throw new ForbiddenException("Not authenticated");
      }

      const user = await this.authService.getById(localUserId);
      if (!user) throw new ForbiddenException("Not authenticated");

      if (!(await this.authService.hasStepUp(user.shadoUserId, scope))) {
         throw new ForbiddenException(`2FA verification required for "${scope}"`);
      }
      return true;
   }
}
