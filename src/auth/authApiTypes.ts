/**
 * Types for all The Requests and Responses of the Auth Controller
 */
import { ApiProperty } from "@nestjs/swagger";
import { User } from "src/models/user";

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

// Login
export class LoginRequest {
	@ApiProperty()
	email: string;

	@ApiProperty()
	password: string;
}

export class LoginResponse extends ErrorProne {
	@ApiProperty()
	user: User;
}

// Register
export class RegisterRequest {
	@ApiProperty()
	name: string;
	@ApiProperty()
	email: string;
	@ApiProperty()
	password: string;
}

// Cookie
export type CookiePayload = {
	userId: number;
};
