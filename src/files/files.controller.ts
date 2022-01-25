import {
	Body,
	Controller,
	Delete,
	Get,
	Logger,
	Param,
	Patch,
	Post,
	Query,
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express";
import {
	ApiConsumes,
	ApiParam,
	ApiProduces,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { errorLog } from "src/logging";
import { ApiFile, AuthUser } from "src/util";
import { FilesService } from "./files.service";
import {
	FileInfoResponse,
	NewFileRequest,
	OperationStatus,
	OperationStatusResponse,
	RenameFileRequest,
	SaveFileRequest,
} from "./filesApiTypes";
@Controller("file")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Files")
export class FilesConstoller {
	constructor(private fileService: FilesService) {}

	@Get(":path")
	@ApiResponse({ description: "Returns a stream of the requested file" })
	@ApiParam({
		name: "path",
		description: "File relative path + file name + extension",
		type: String,
	})
	public async getFile(
		@Param("path") path: string,
		@AuthUser() userId: number,
		@Res() res: Response
	) {
		try {
			const file = await this.fileService.asStream(userId, path);
			file.pipe(res);
		} catch (e) {
			errorLog(e, FilesConstoller, userId);
			res.send({
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "path", message: (<Error>e).message }],
			});
		}
	}

	@Post("upload")
	@ApiResponse({ type: OperationStatusResponse })
	@ApiConsumes("multipart/form-data")
	@ApiFile()
	@UseInterceptors(FileInterceptor("file"))
	public async upload(
		@AuthUser() userId: number,
		@UploadedFile() file: Express.Multer.File,
		@Body() body: { dest: string }
	) {
		const data = await this.fileService.upload(userId, file, body.dest);
		return this.returnObject(data, userId);
	}

	@Post("new")
	@ApiResponse({ type: OperationStatusResponse })
	public async new(
		@Body() body: NewFileRequest,
		@AuthUser() userId: number
	): Promise<OperationStatusResponse> {
		const data = await this.fileService.new(userId, body.name);
		return this.returnObject(data, userId);
	}

	@Patch("save")
	@ApiResponse({ type: OperationStatusResponse })
	public async save(
		@Body() body: SaveFileRequest,
		@AuthUser() userId: number
	): Promise<OperationStatusResponse> {
		const data = await this.fileService.save(
			userId,
			body.name,
			body.content,
			body.append
		);
		return this.returnObject(data, userId);
	}

	@Delete("delete")
	@ApiResponse({ type: OperationStatusResponse })
	public async delete(
		@Body() body: NewFileRequest,
		@AuthUser() userId: number
	) {
		const data = await this.fileService.delete(userId, body.name);

		return this.returnObject(data, userId);
	}

	@Patch("rename")
	@ApiResponse({ type: OperationStatusResponse })
	public async rename(
		@Body() body: RenameFileRequest,
		@AuthUser() userId: number
	) {
		const data = await this.fileService.rename(userId, body.name, body.newName);
		return this.returnObject(data, userId);
	}

	@Get("info/:path")
	@ApiParam({ name: "path" })
	@ApiResponse({ type: FileInfoResponse })
	public async info(
		@Param("path") path: string,
		@AuthUser() userId: number
	): Promise<FileInfoResponse> {
		try {
			const info = await this.fileService.info(userId, path);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				data: info,
				errors: [],
			};
		} catch (e) {
			errorLog(e, FilesConstoller, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				data: null,
				errors: [],
			};
		}
	}

	@Get("thumbnail/:path")
	@ApiResponse({
		description: "Returns a thumnail stream of the requested file",
	})
	@ApiParam({
		name: "path",
		description: "File relative path + file name + extension",
		type: String,
	})
	public async thumbnail(
		@Param("path") path: string,
		@AuthUser() userId: number,
		@Res() res: Response,
		@Query("width") width: number | undefined,
		@Query("height") height: number | undefined
	) {
		try {
			const stream = await this.fileService.toThumbnail(
				path,
				userId,
				width,
				height
			);
			stream.pipe(res);
		} catch (e) {
			errorLog(e, FilesConstoller, userId);
			res.send({
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "path", message: (<Error>e).message }],
			});
		}
	}

	private returnObject([success, message]: [boolean, string], userId?: number) {
		if (success) {
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} else {
			errorLog(new Error(message), FilesConstoller, userId);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message }],
			};
		}
	}
}
