import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
	OperationStatus,
	OperationStatusResponse,
} from "src/files/filesApiTypes";
import { errorLog } from "src/logging";
import { UploadedFile } from "src/models/uploadedFile";
import { AuthUser } from "src/util";
import { DirectoriesService } from "./directories.service";
import {
	DirectoryInfo,
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
		try {
			return {
				rootDir: await this.directoriesService.root(userId),
			};
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return {
				rootDir: "",
			};
		}
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
			errorLog(e, DirectoriesController, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				data: null,
				parent: null,
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	@Get("listrecursive")
	@ApiResponse({ type: [String] })
	public async listrecursive(@AuthUser() userId: number) {
		try {
			return await this.directoriesService.listrecursive(userId);
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return [];
		}
	}

	@Post("new")
	@ApiResponse({ type: OperationStatusResponse })
	public async new(
		@AuthUser() userId: number,
		@Body() body: NewDirRequest
	): Promise<OperationStatusResponse> {
		try {
			await this.directoriesService.new(userId, body.name);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "path", message: (<Error>e).message }],
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
			errorLog(e, DirectoriesController, userId);
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
			errorLog(e, DirectoriesController, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	@Get("search")
	@ApiQuery({ name: "val" })
	@ApiResponse({ type: [UploadedFile] })
	public async search(
		@AuthUser() userId: number,
		@Query("val") searchText: string
	) {
		try {
			return await this.directoriesService.search(userId, searchText);
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return [];
		}
	}

	@Patch("zip")
	@ApiResponse({ type: OperationStatusResponse })
	public zip(
		@AuthUser() userId: number,
		@Body() body: NewDirRequest
	): OperationStatusResponse {
		try {
			this.directoriesService
				.zip(userId, body.name)
				.catch((e) => errorLog(e, DirectoriesController, userId));
			return {
				status: OperationStatus[OperationStatus.ONGOING],
				errors: [],
			};
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	@Patch("unzip")
	@ApiResponse({ type: OperationStatusResponse })
	public unzip(@AuthUser() userId: number, @Body() body: NewDirRequest) {
		try {
			this.directoriesService
				.unzip(userId, body.name)
				.catch((e) => errorLog(e, DirectoriesController, userId));

			return {
				status: OperationStatus[OperationStatus.ONGOING],
				errors: [],
			};
		} catch (e) {
			errorLog(e, DirectoriesController, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}
}
