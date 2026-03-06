/**
 * Utility functions
 */
import { ApiBody } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";

export const REDIS_CACHE = "REDIS_CACHE" as const;

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

/**
 * Converts an enum to array of string
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

/**
 * Returns true if the current environment is set to development
 */
export function isDev(config: ConfigService<EnvVariables>) {
   return config.get("ENV") == "dev" || config.get("ENV") == "development";
}
