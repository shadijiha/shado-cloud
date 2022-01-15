import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
	NewFileRequest,
	OperationStatus,
	OperationStatusResponse,
} from "src/files/filesApiTypes";
import { AuthUser } from "src/util";
import { DirectoriesService } from "./directories.service";
import {
	DirListResponse,
	NewDirRequest,
	RenameDirRequest,
} from "./directoriesApiTypes";

@Controller("directory")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Directories")
export class DirectoriesController {
	constructor(private readonly directoriesService: DirectoriesService) {}

	@Get("root")
	public async root(@AuthUser() userId: number) {
		return {
			rootDir: await this.directoriesService.root(userId),
		};
	}

	@Get("list/:path?")
	@ApiParam({ name: "path", type: String, allowEmptyValue: true })
	@ApiResponse({ type: DirListResponse })
	public async list(
		@AuthUser() userId: number,
		@Param("path") path: string
	): Promise<DirListResponse> {
		try {
			const list = await this.directoriesService.list(userId, path ?? "");

			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				parent: this.directoriesService.parent(path),
				data: list,
				errors: [],
			};
		} catch (e) {
			return {
				status: OperationStatus[OperationStatus.FAILED],
				data: null,
				parent: null,
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	@Post("new")
	@ApiResponse({ type: OperationStatusResponse })
	public async new(@AuthUser() userId: number, @Body() body: NewDirRequest) {
		try {
			await this.directoriesService.new(userId, body.name);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
			};
		} catch (e) {
			return {
				status: OperationStatus[OperationStatus.FAILED],
			};
		}
	}

	@Delete("delete")
	@ApiResponse({ type: OperationStatusResponse })
	public async delete(@AuthUser() userId: number, @Body() body: NewDirRequest) {
		try {
			await this.directoriesService.delete(userId, body.name);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
			};
		} catch (e) {
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	@Patch("rename")
	@ApiResponse({ type: OperationStatusResponse })
	public async rename(
		@AuthUser() userId: number,
		@Body() body: RenameDirRequest
	) {
		try {
			await this.directoriesService.rename(userId, body.name, body.newName);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
			};
		} catch (e) {
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}
}
