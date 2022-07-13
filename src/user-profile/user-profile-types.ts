import { ApiProperty } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { EncryptedPassword } from "src/models/EncryptedPassword";

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

export class ChangePictureRequest {
	@ApiProperty()
	password: string;
}

class AddToVaultElement {
	@ApiProperty()
	username: string;

	@ApiProperty()
	password_to_encrypt: string;

	@ApiProperty()
	website: string;
}

export class AddToVaultRequest {
	@ApiProperty({ type: [AddToVaultElement] })
	elements: AddToVaultElement[];
}

export class AddToVaultResponse extends OperationStatusResponse {
	@ApiProperty({ type: [EncryptedPassword] })
	result: EncryptedPassword[];
}

export class PasswordsVaultAllResponse extends OperationStatusResponse {
	@ApiProperty({ type: [EncryptedPassword] })
	passwords: EncryptedPassword[];
}

/**
 * For pagination
 */
class Meta {
	@ApiProperty()
	itemsPerPage: number;
	@ApiProperty()
	totalItems: number;
	@ApiProperty()
	currentPage: number;
	@ApiProperty()
	totalPages: number;
	@ApiProperty()
	sortBy: string[][];
}
class Links {
	@ApiProperty()
	first: string;
	@ApiProperty()
	current: string;
	@ApiProperty()
	previous: string;
	@ApiProperty()
	next: string;
	@ApiProperty()
	last: string;
}

class Pages {
	@ApiProperty({ type: Meta })
	meta: Meta;
	@ApiProperty({ type: Links })
	links: Links;
}

export class AllPasswordsResponse extends Pages {
	@ApiProperty({ type: [EncryptedPassword] })
	data: EncryptedPassword[];
}
