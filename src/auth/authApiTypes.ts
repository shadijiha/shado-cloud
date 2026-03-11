/**
 * Shared API types
 */
import { ApiProperty } from "@nestjs/swagger";

class FieldError {
   @ApiProperty()
   field: string;

   @ApiProperty()
   message: string;
}

export class ErrorProne {
   @ApiProperty({ type: [FieldError] })
   errors: FieldError[] = [];
}
