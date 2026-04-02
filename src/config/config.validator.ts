import { Logger } from "@nestjs/common";
import { plainToInstance, Type } from "class-transformer";
import {
   IsEmail,
   IsEnum,
   IsInt,
   IsNumber,
   IsOptional,
   isString,
   IsString,
   Max,
   Min,
   MinLength,
   Validate,
   ValidateIf,
   ValidateNested,
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
 * Enums and common configs
 */
enum Stage {
   Development = "development",
   Production = "production",
   Dev = "dev",
   Prod = "prod",
}

class PortConfig {
   @IsInt()
   @Min(1200)
   @Max(90000)
   http: number;

   @IsInt()
   @Min(1200)
   @Max(90000)
   tcp: number;
}

export enum ReplicationRole {
   Master = "master",
   Primary = "primary",
   Replica = "replica",
}

/* ---------------- THIS SERVICE ---------------- */
class ReplicationConfig {
   @IsEnum(ReplicationRole)
   role: ReplicationRole

   @IsString()
   @ValidateIf((o) => o.role === ReplicationRole.Replica)
   "master-or-replica-ip": string
}

class GoogleConfig {
   @IsEmail()
   @IsOptional()
   email: string

   @IsString()
   @IsOptional()
   "client-id": string

   @IsString()
   @IsOptional()
   "client-secret": string;

   @IsString()
   @IsOptional()
   "refresh-token": string;
}

class DeploymentConfig {
   @IsString()
   @IsOptional()
   "github-webhook-secret": string;
}

class ThisServiceConfig {
   @IsEnum(Stage)
   stage: Stage;

   @IsString()
   host: string;

   @ValidateNested()
   @Type(() => PortConfig)
   port: PortConfig;

   @Validate(ValidFilePath)
   @Validate(DoesNotEndWithConstraint, ["/"])
   @Validate(DoesNotEndWithConstraint, ["\\"])
   "cloud-dir": string;

   @MinLength(3)
   @IsString()
   "password-vault-salt": string;

   @ValidateNested()
   @Type(() => ReplicationConfig)
   replication: ReplicationConfig;

   @IsString()
   @Validate(DoesNotEndWithConstraint, ["/"])
   frontend_url: string;

   @ValidateNested()
   @Type(() => GoogleConfig)
   @IsOptional()
   google: GoogleConfig;

   @ValidateNested()
   @Type(() => DeploymentConfig)
   @IsOptional()
   deployment: DeploymentConfig;
}

/* ---------------- CROSS SERVICE ---------------- */

class MicroServiceApiConfig {
   @IsString()
   @Validate(DoesNotEndWithConstraint, ["/"])
   host: string;

   @ValidateNested()
   @Type(() => PortConfig)
   port: PortConfig;
}

class CrossServiceConfig {
   @MinLength(8)
   @IsString()
   secret: string;

   @ValidateNested()
   @Type(() => MicroServiceApiConfig)
   "auth-api": MicroServiceApiConfig;

   @ValidateNested()
   @Type(() => MicroServiceApiConfig)
   "metrics-api": MicroServiceApiConfig;
}

/* ---------------- DATABASE ---------------- */

class DbConfig {
   @IsString()
   type: string;

   @IsString()
   @Validate(DoesNotEndWithConstraint, ["/"])
   host: string;

   @IsInt()
   @Min(0)
   @Max(65535)
   port: number;

   @IsString()
   username: string;

   @IsString()
   @IsOptional()
   password: string;

   @IsString()
   name: string;
}

/* ---------------- REDIS ---------------- */

class RedisConfig {
   @IsString()
   @Validate(DoesNotEndWithConstraint, ["/"])
   host: string;

   @IsInt()
   @Min(0)
   @Max(65535)
   port: number;

   @IsString()
   @IsOptional()
   password: string;
}

export class EnvVariables {
   
   @ValidateNested()
   @Type(() => ThisServiceConfig)
   "this-service": ThisServiceConfig;

   @ValidateNested()
   @Type(() => CrossServiceConfig)
   "cross-service": CrossServiceConfig;

   @ValidateNested()
   @Type(() => DbConfig)
   db: DbConfig;

   @ValidateNested()
   @Type(() => RedisConfig)
   redis: RedisConfig;
}

export function validate(config: Record<string, unknown>) {
   const validatedConfig = plainToInstance(EnvVariables, config, { enableImplicitConversion: true });
   const errors = validateSync(validatedConfig, { skipMissingProperties: false });

   if (errors.length > 0) {
      logErrors(errors);
      throw new Error(errors.toString());
   }
   return validatedConfig;
}

function logErrors(errors: any[], parent = '') {
  for (const error of errors) {
    const propertyPath = parent
      ? `${parent}.${error.property}`
      : error.property;

    if (error.constraints) {
      Object.entries(error.constraints).forEach(([key, value]) => {
        Logger.error(`${propertyPath} => ${value}`);
      });
    }

    if (error.children && error.children.length > 0) {
      logErrors(error.children, propertyPath);
    }
  }
}