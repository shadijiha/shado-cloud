import { ApiProperty } from "@nestjs/swagger";
import { ErrorProne } from "../auth/authApiTypes";
import { enumToArray } from "../util";

export class NewFileRequest {
	@ApiProperty({ example: "Relative path + file name + file extension" })
	name: string;
}

export class SaveFileRequest extends NewFileRequest {
	@ApiProperty()
	content: string;

	@ApiProperty({ default: false })
	append?: boolean = false;
}

export class RenameFileRequest extends NewFileRequest {
	@ApiProperty({ example: "Name + extension" })
	newName: string;
}

export enum OperationStatus {
	FAILED,
	SUCCESS,
	ONGOING,
	UNKNOWN,
}

export class OperationStatusResponse extends ErrorProne {
	@ApiProperty({
		enum: enumToArray(OperationStatus),
	})
	status: string;
}

/**
 * Represents information about a file
 */
export class FileInfo {
	@ApiProperty()
	name: string;

	@ApiProperty()
	extension: string;

	@ApiProperty()
	path: string;

	@ApiProperty()
	mime: string;

	@ApiProperty()
	size: number;

	@ApiProperty()
	is_image: boolean;

	@ApiProperty()
	is_video: boolean;

	@ApiProperty()
	is_pdf: boolean;

	@ApiProperty()
	is_text: boolean;

	@ApiProperty()
	is_audio: boolean;
}

export class FileInfoResponse extends ErrorProne {
	@ApiProperty({
		enum: enumToArray(OperationStatus),
	})
	status: string;

	@ApiProperty()
	data: FileInfo;
}

export class OpResWithData extends OperationStatusResponse {
	@ApiProperty()
	data: boolean;
}
