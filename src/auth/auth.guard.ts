import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthService } from "./auth.service";

/**
 * Extracts the cookie, validates via auth microservice (shadoUserId),
 * resolves to local User, attaches numeric userId to request.
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

      const shadoUserId = await this.authService.validateToken(token);
      if (!shadoUserId) throw new UnauthorizedException();

      const user = await this.authService.getUser(shadoUserId);
      if (!user) throw new UnauthorizedException();

      // Downstream gets numeric userId for DB relations
      request.authUserId = user.id;
      return true;
   }
}
