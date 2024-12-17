import {
    ArgumentMetadata,
    BadRequestException,
    HttpException,
    HttpStatus,
    Logger,
    ValidationError,
    ValidationPipe,
} from "@nestjs/common";
import { plainToClass } from "class-transformer";
import { validate } from "class-validator";

export class ValidationPipeline extends ValidationPipe {
    async transform(value, metadata: ArgumentMetadata) {
        if (!value) {
            throw new BadRequestException("No data submitted");
        }

        const { metatype } = metadata;
        if (!metatype || !this.toValidate(metatype)) {
            return value;
        }

        const object = plainToClass(metatype, value);
        const errors = await validate(object);
        if (errors.length > 0) {
            throw new HttpException(
                {
                    message: "Input data validation failed",
                    errors: this.buildError(errors),
                },
                HttpStatus.BAD_REQUEST,
            );
        }
        return value;
    }

    private buildError(errors: ValidationError[]) {
        return errors.map((e) => {
            return {
                field: e.property,
                message: e.constraints[Object.keys(e.constraints)[0]],
            };
        });
    }

    public toValidate(metatype): boolean {
        const types = [String, Boolean, Number, Array, Object];
        return !types.find((type) => metatype === type);
    }
}
