import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, Max, Min } from "class-validator";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

/**
 * Feature flag endpoints DTO
 */
export class CreateFeatureFlagRequest {
   @ApiProperty({ enum: FeatureFlagNamespace })
   @IsNotEmpty()
   @IsEnum(FeatureFlagNamespace)
   namespace: FeatureFlagNamespace;

   @ApiProperty()
   @IsNotEmpty()
   key: string;

   @ApiProperty()
   @IsOptional()
   payload?: string;

   @ApiProperty()
   @IsOptional()
   description?: string;
}

export class UpdateFeatureFlagRequest {
   @ApiProperty()
   @IsOptional()
   payload?: string;

   @ApiProperty()
   @IsOptional()
   description?: string;
}

/**
 * Database endpoints DTO
 */
export class DatabaseGetTableRequest {
   public static readonly OrderyByOptions = ["ASC", "DESC"] as const;

   @ApiProperty({ description: "The limit of the number of rows to return" })
   @IsNumber()
   @Max(500)
   @Min(1)
   limit: number;

   @ApiProperty({
      enum: DatabaseGetTableRequest.OrderyByOptions,
      description: "The order to return the rows in",
   })
   @IsEnum(DatabaseGetTableRequest.OrderyByOptions)
   order_by: (typeof DatabaseGetTableRequest.OrderyByOptions)[number];

   @ApiProperty({ description: "The column to order by" })
   @IsOptional()
   order_column?: string;

   @ApiProperty({ description: "Search filter string" })
   @IsOptional()
   search?: string;

   @ApiProperty({ description: "Column to search in" })
   @IsOptional()
   search_column?: string;
}
