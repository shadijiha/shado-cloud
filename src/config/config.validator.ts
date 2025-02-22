import { Logger } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import {
   IsEmail,
   IsEnum,
   IsInt,
   IsNumber,
   IsOptional,
   IsString,
   Max,
   Min,
   MinLength,
   Validate,
   validateSync,
   ValidationArguments,
   ValidatorConstraint,
   ValidatorConstraintInterface,
} from "class-validator";
import fs from "fs";

/**
 * Validation helpers
 */
@ValidatorConstraint({ async: false })
class DoesNotContainSubstringConstraint implements ValidatorConstraintInterface {
   // Validate method checks if the string does not contain the forbidden substring
   validate(value: string, args: any) {
      const forbiddenSubstring = args.constraints[0]; // The substring to check for
      if (!value || typeof value !== "string") {
         return true; // Skip validation if the value is not a string
      }
      return !value.includes(forbiddenSubstring); // Return true if the string does not contain the substring
   }

   // Custom error message when validation fails
   defaultMessage() {
      return "String contains a forbidden substring";
   }
}

@ValidatorConstraint({ async: false })
class ContainsReferenceValueConstraint implements ValidatorConstraintInterface {
   validate(value: string, args: ValidationArguments) {
      const [relatedProperty] = args.constraints;
      const object = args.object as any; // Get the full object (DTO)

      // Check if the `value` (current property) contains the `relatedProperty` (reference value)
      return value?.includes(object[relatedProperty]);
   }

   defaultMessage(args: ValidationArguments): string {
      return `${args.property} must contain the reference value ${args.constraints[0]}`;
   }
}

@ValidatorConstraint({ async: false })
class DoesNotEndWithConstraint implements ValidatorConstraintInterface {
   // Validate method checks if the string does not end with the given substring
   validate(value: string, args: ValidationArguments) {
      const [forbiddenSubstring] = args.constraints; // Get the forbidden substring from the constraints
      if (!value || typeof value !== "string") {
         return true; // Skip validation if value is not a string
      }
      return !value.endsWith(forbiddenSubstring); // Return true if the string does not end with the forbidden substring
   }

   // Custom error message when validation fails
   defaultMessage(args: ValidationArguments): string {
      return `${args.property} must not end with the substring "${args.constraints[0]}"`;
   }
}

@ValidatorConstraint({ async: false })
class ValidFilePath implements ValidatorConstraintInterface {
   // Validate method checks if the string does not end with the given substring
   validate(value: string, args: ValidationArguments) {
      return fs.existsSync(value); // Return true if the string does not end with the forbidden substring
   }

   // Custom error message when validation fails
   defaultMessage(args: ValidationArguments): string {
      return `${args.property} must be a valid filepath! path ${args.value} does exist`;
   }
}

/**
 * enums
 */
enum Environment {
   Development = "development",
   Production = "production",
   Dev = "dev",
   Prod = "prod",
}

export enum ReplicationRole {
   Master = "master",
   Replica = "replica",
}

export class EnvVariables {
   /**
    * Env and replication
    */
   @IsEnum(Environment)
   ENV: Environment;

   @IsInt()
   @IsOptional()
   @Min(1200)
   @Max(90000)
   APP_PORT: number | undefined;

   @IsEnum(ReplicationRole)
   REPLICATION_ROLE: ReplicationRole;

   @IsString()
   @IsOptional()
   MASTER_OR_REPLICA_LOCAL_IP: string | undefined;

   @Validate(ValidFilePath)
   @Validate(DoesNotEndWithConstraint, ["/"])
   @Validate(DoesNotEndWithConstraint, ["\\"])
   CLOUD_DIR: string;

   /**
    * Cookies and auth
    */
   @MinLength(3)
   PASSWORD_VAULT_SALT: string;

   @MinLength(5)
   COOKIE_NAME: string;

   @MinLength(4)
   JWT_SECRET: string;

   @Validate(DoesNotContainSubstringConstraint, ["/"])
   BACKEND_HOST_NAME: string;

   @Validate(DoesNotEndWithConstraint, ["/"])
   FRONTEND_URL: string;

   @Validate(ContainsReferenceValueConstraint, ["BACKEND_HOST_NAME"])
   @Validate(DoesNotEndWithConstraint, ["/"])
   BACKEND_HOST: string;

   /**
    * Github webhooks env
    */
   @IsOptional()
   GITHUB_WEBHOOK_SECRET: string;

   @IsOptional()
   @IsEmail()
   EMAIL_USER: string;

   @IsOptional()
   EMAIL_APP_PASSWORD: string;

   @IsOptional()
   @Validate(DoesNotEndWithConstraint, ["/"])
   @Validate(ValidFilePath)
   FRONTEND_DEPLOY_PATH: string;

   /**
    * Database env
    */
   DB_TYPE: "mysql" | "sqlite";

   @Validate(DoesNotEndWithConstraint, ["/"])
   DB_HOST: string;

   @IsNumber()
   @Min(0)
   @Max(65535)
   DB_PORT: number;

   DB_USERNAME: string;

   DB_PASSWORD: string;

   DB_NAME: string;

   /**
    * Redis env
    */
   @Validate(DoesNotEndWithConstraint, ["/"])
   REDIS_HOST: string;

   @IsNumber()
   @Min(0)
   @Max(65535)
   REDIS_PORT: number;

   REDIS_PASSWORD: string;
}

export function validate(config: Record<string, unknown>) {
   const validatedConfig = plainToInstance(EnvVariables, config, { enableImplicitConversion: true });
   const errors = validateSync(validatedConfig, { skipMissingProperties: false });

   if (errors.length > 0) {
      for (const error of errors) {
         Object.entries(error.constraints).forEach(([key, value]) => {
            Logger.error(`${key} => ${value}`);
         });

         Logger.error("----------------------");
      }

      throw new Error(errors.toString());
   }
   return validatedConfig;
}
