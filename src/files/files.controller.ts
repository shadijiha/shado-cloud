import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Logger,
	Param,
	Patch,
	Post,
	Query,
	Req,
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
	ApiProperty,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { LoggerToDb } from "./../logging";
import { ApiFile, AuthUser } from "src/util";
import { FilesService } from "./files.service";
import {
	FileInfoResponse,
	NewFileRequest,
	OperationStatus,
	OperationStatusResponse,
	OpResWithData,
	RenameFileRequest,
	SaveFileRequest,
} from "./filesApiTypes";
@Controller("file")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Files")
export class FilesConstoller {
	constructor(
		private fileService: FilesService,
		@Inject() private readonly logger: LoggerToDb,
	) {}

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
		@Res() res: Response,
		@Req() req: Request
	) {
		try {
			const fileInto = await this.fileService.info(userId, path);

			// In case that it is a video or audio
			// We need to see if this request is for seeking
			if (fileInto.is_video || fileInto.is_audio) {
				/*res.set({
					"Content-Type": fileInto.mime,
					"Content-Disposition": `filename="${fileInto.name}"`,
					"Content-Length": fileInto.size,
				});*/

				const total = fileInto.size;
				if (req.headers.range) {
					const range = req.headers.range;
					const parts = range.replace(/bytes=/, "").split("-");
					const partialstart = parts[0];
					const partialend = parts[1];

					const start = parseInt(partialstart, 10);
					const end = partialend ? parseInt(partialend, 10) : total - 1;
					const chunksize = end - start + 1;

					const file = await this.fileService.asStream(
						userId,
						path,
						req.headers["user-agent"],
						{
							start: start,
							end: end,
						}
					);
					res.writeHead(206, {
						"Content-Range": "bytes " + start + "-" + end + "/" + total,
						"Accept-Ranges": "bytes",
						"Content-Length": chunksize,
						"Content-Type": fileInto.mime,
					});

					file.pipe(res);
				} else {
					res.writeHead(200, {
						"Content-Length": total,
						"Content-Type": fileInto.mime,
					});
					(
						await this.fileService.asStream(
							userId,
							path,
							req.headers["user-agent"]
						)
					).pipe(res);
				}
			}
			// Otherwise for any other file just do a simple stream
			else {
				const file = await this.fileService.asStream(
					userId,
					path,
					req.headers["user-agent"]
				);
				res.writeHead(200, {
					"Content-Type": fileInto.mime,
					"Content-Length": fileInto.size,
				});
				file.pipe(res);
			}
		} catch (e) {
			this.logger.logException(e);
			res.status(400).send({
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
		return await this.logger.errorWrapper(
			async () => {
				await this.fileService.upload(userId, file, body.dest);
			}
		);
	}

	@Post("new")
	@ApiResponse({ type: OperationStatusResponse })
	public async new(
		@Body() body: NewFileRequest,
		@AuthUser() userId: number
	): Promise<OperationStatusResponse> {
		return await this.logger.errorWrapper(
			async () => {
				await this.fileService.new(userId, body.name);
			}
		);
	}

	@Patch("save")
	@ApiResponse({ type: OperationStatusResponse })
	public async save(
		@Body() body: SaveFileRequest,
		@AuthUser() userId: number
	): Promise<OperationStatusResponse> {
		const [success, message] = await this.fileService.save(
			userId,
			body.name,
			body.content,
			body.append
		);
		if (success) {
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} else {
			this.logger.logException(new Error(message));
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message }],
			};
		}
	}

	@Delete("delete")
	@ApiResponse({ type: OperationStatusResponse })
	public async delete(
		@Body() body: NewFileRequest,
		@AuthUser() userId: number
	) {
		const [success, message] = await this.fileService.delete(userId, body.name);
		if (success) {
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} else {
			this.logger.logException(new Error(message));
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message }],
			};
		}
	}

	@Patch("rename")
	@ApiResponse({ type: OperationStatusResponse })
	public async rename(
		@Body() body: RenameFileRequest,
		@AuthUser() userId: number
	) {
		return this.logger.errorWrapper(
			async () => {
				await this.fileService.rename(userId, body.name, body.newName);
			}
		);
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
			this.logger.logException(e);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				data: null,
				errors: [],
			};
		}
	}

	@Get("exists/:path")
	@ApiParam({ name: "path" })
	@ApiResponse({ type: OpResWithData })
	public async exists(@Param("path") path: string, @AuthUser() userId: number) {
		try {
			const info = await this.fileService.exists(userId, path);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				data: info,
				errors: [],
			};
		} catch (e) {
			this.logger.logException(e);
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
			this.logger.logException(e);
			res.send({
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "path", message: (<Error>e).message }],
			});
		}
	}
}
