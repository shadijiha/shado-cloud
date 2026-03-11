/**
 * Utility functions
 */
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { ApiBody } from "@nestjs/swagger";
import { type Request } from "express";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";

export const REDIS_CACHE = "REDIS_CACHE" as const;

/**
 * Extracts the authenticated userId from the request.
 * Requires JwtAuthGuard to have run first (sets request.authUserId).
 */
export const AuthUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
   const request = ctx.switchToHttp().getRequest();
   return request.authUserId ?? -1;
});

/**
 * Gets userId from request — for use outside of guards (logging, interceptors).
 * Falls back to -1 if not authenticated.
 */
export function getUserIdFromRequest(request: any): number | -1 {
   return request?.authUserId ?? -1;
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

type Enum = Record<number, string>;

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

export function isDev(config: ConfigService<EnvVariables>) {
   return config.get("ENV") == "dev" || config.get("ENV") == "development";
}
