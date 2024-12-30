import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsOptional } from "class-validator";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

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
