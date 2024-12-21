import { Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { type CookiePayload } from "./authApiTypes";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

@Injectable()
export class AuthStrategy extends PassportStrategy(Strategy) {
   constructor(@Inject() private readonly config: ConfigService<EnvVariables>) {
      super({
         jwtFromRequest: (req) => {
            if (!req?.cookies) return null;
            return req.cookies[config.get("COOKIE_NAME")];
         },
         ignoreExpiration: false,
         secretOrKey: config.get("JWT_SECRET"),
      });
   }

   async validate(data: CookiePayload) {
      // Check if user is banned etc
      return true;
   }
}
