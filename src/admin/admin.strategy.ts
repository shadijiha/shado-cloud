import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { type Request } from "express";
import { AuthStrategy } from "src/auth/auth.strategy";
import { type CookiePayload } from "src/auth/authApiTypes";
import { EnvVariables } from "src/config/config.validator";
import { User } from "src/models/user";
import { parseJwt } from "src/util";
import { Repository } from "typeorm";

@Injectable()
export class AdminGuard implements CanActivate {
   public constructor(
      @InjectRepository(User) private readonly userRepo: Repository<User>,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {}

   async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const request = ctx.switchToHttp().getRequest();
      const payload = parseJwt(request.cookies[this.config.get<string>("COOKIE_NAME")]) as CookiePayload;

      if (!payload?.userId) {
         return false;
      }

      const user = await this.userRepo.findOne({ where: { id: payload.userId } });
      if (user) {
         return user.is_admin;
      }
      return false;
   }
}
