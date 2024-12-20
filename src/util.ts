/**
 * Utlity functions
 */
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { ApiBody } from "@nestjs/swagger";
import { type Request } from "express";
import { type CookiePayload } from "./auth/authApiTypes";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";

/**
 * @example Use this function as decorator on top of controller functions
 * @returns Returns the logged in user
 */
export const AuthUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
   const request = ctx.switchToHttp().getRequest();
   const config = request.configService;
   const token = parseJwt(request.cookies[config.get("COOKIE_NAME")]);
   const payload = token == null ? { userId: -1 } : (token as CookiePayload);

   return payload.userId;
});

export function getUserIdFromRequest(request: Request & { configService: ConfigService<EnvVariables> }): number | -1 {
   const token = parseJwt(request.cookies[request.configService.get("COOKIE_NAME")]);
   const payload = token == null ? { userId: -1 } : (token as CookiePayload);
   return payload.userId;
}

export const ApiFile =
   (fileName = "file"): MethodDecorator =>
   (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
      ApiBody({
         schema: {
            type: "object",
            properties: {
               dest: {
                  type: "string",
               },
               [fileName]: {
                  type: "string",
                  format: "binary",
               },
            },
         },
      })(target, propertyKey, descriptor);
   };

/**
 * Parses the JWT token sent as cookie
 * @param token The token to parse
 * @returns Returns the json object with the JWT data
 */
export function parseJwt(token: string | undefined): Object | null {
   if (!token) {
      return null;
   }
   const base64Url = token.split(".")[1];
   const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
   const jsonPayload = decodeURIComponent(
      Buffer.from(base64, "base64")
         .toString()
         .split("")
         .map(function (c) {
            return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
         })
         .join(""),
   );

   return JSON.parse(jsonPayload);
}

type Enum = Record<number, string>;

/**
 * Converts an enum to array of string
 * @param _enum The enum type
 * @returns Returns all the values names of the enum
 */
export function enumToArray(_enum: Enum): string[] {
   return Object.values(_enum)
      .filter((value) => typeof value === "string")
      .map((value) => value);
}

/**
 * A soft exception is an exception that doesn't need to be logged
 */
export class SoftException extends Error {
   public constructor(message?: string) {
      super(message);
   }
}
