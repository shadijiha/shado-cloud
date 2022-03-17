import { ApiProperty } from "@nestjs/swagger";

export class ChangePasswordRequest {
	@ApiProperty()
	old_password: string;

	@ApiProperty()
	new_password: string;
}

export class ChangeNameRequest {
	@ApiProperty()
	password: string;

	@ApiProperty()
	new_name: string;
}
