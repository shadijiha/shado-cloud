import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * Extracts the authenticated user's ID (string UUID from auth microservice).
 * Must be used with AuthGuardService.
 */
export const AuthedUserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
   return ctx.switchToHttp().getRequest().authUser.id;
});

/**
 * Extracts the authenticated user's email.
 * Must be used with AuthGuardService.
 */
export const AuthedUserEmail = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
   return ctx.switchToHttp().getRequest().authUser.email;
});
