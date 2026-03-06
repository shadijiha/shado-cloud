import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Must be used AFTER AuthGuardService in the guards chain.
 * Checks if the authenticated user is an admin.
 */
@Injectable()
export class AdminGuard implements CanActivate {
   canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      return !!req.authUser?.isAdmin;
   }
}
