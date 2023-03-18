import { ApiProperty } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { EncryptedPassword } from "src/models/EncryptedPassword";
import { SearchStat } from "src/models/stats/searchStat";
import { UploadedFile } from "src/models/uploadedFile";

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

export class ProfileCropData {
	@ApiProperty()
	x: number;
	@ApiProperty()
	y: number;
	@ApiProperty()
	width: number;
	@ApiProperty()
	height: number;
	@ApiProperty()
	unit: "px" | "%";
}

export class ChangePictureRequest {
	@ApiProperty()
	password: string;

	@ApiProperty()
	crop: ProfileCropData | string | undefined;
}

/**
 * Stats API Types
 */
class AccessFileStat {
	@ApiProperty()
	access_count: number;
	@ApiProperty({ type: UploadedFile })
	file: UploadedFile;
}
class MostSearchStat {
	@ApiProperty()
	search_count: number;
	@ApiProperty({ type: SearchStat })
	search: SearchStat;
}
export class UsedData {
	@ApiProperty()
	max: number;
	@ApiProperty()
	images: number = 0;
	@ApiProperty()
	videos: number = 0;
	@ApiProperty()
	other: number = 0;
	@ApiProperty()
	documents: number = 0;

	public total() {
		return this.images + this.videos + this.other + this.documents;
	}
}
export class ProfileStats {
	@ApiProperty({ type: [AccessFileStat] })
	most_accesed_files: AccessFileStat[];
	@ApiProperty({ type: [MostSearchStat] })
	most_searched: MostSearchStat[];
	@ApiProperty({ type: UsedData })
	used_data: UsedData;
}

/**
 * Password vault API
 */
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
