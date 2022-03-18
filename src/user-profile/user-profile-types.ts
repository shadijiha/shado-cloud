import { ApiProperty } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { PasswordsVault } from "src/models/PasswordsVault";

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

class AddToVaultElement {
	@ApiProperty()
	username: string;

	@ApiProperty()
	password_to_encrypt: string;
}

export class AddToVaultRequest {
	@ApiProperty({ type: [AddToVaultElement] })
	elements: AddToVaultElement[];
}

export class PasswordsVaultAllResponse extends OperationStatusResponse {
	@ApiProperty({ type: [PasswordsVault] })
	passwords: PasswordsVault[];
}
