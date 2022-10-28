/**
 *
 */

import { ApiProperty } from "@nestjs/swagger";
import { ErrorProne } from "src/auth/authApiTypes";
import { FileInfo, OperationStatus } from "src/files/filesApiTypes";
import { enumToArray } from "src/util";

export class DirectoryInfo {
	@ApiProperty()
	path: string;

	@ApiProperty()
	name: string;

	@ApiProperty()
	is_dir: boolean = true;

	@ApiProperty()
	is_protected: boolean;
}

export class DirListResponse extends ErrorProne {
	@ApiProperty({
		enum: enumToArray(OperationStatus),
	})
	status: string;

	@ApiProperty()
	parent: string;

	@ApiProperty({ type: [Object] })
	data: (DirectoryInfo | FileInfo)[];
}

export class WithPass {
	@ApiProperty({ example: "password used to protect", nullable: true })
	password?: string;
}

export class NewDirRequest extends WithPass {
	@ApiProperty({ example: "relative path + name" })
	name: string;
}

export class RenameDirRequest extends NewDirRequest {
	@ApiProperty({ example: "new relative path + name" })
	newName: string;
}
