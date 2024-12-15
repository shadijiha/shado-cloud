import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Req,
	Res,
	UseGuards,
	Headers,
	Inject,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import {
	OperationStatus,
	OperationStatusResponse,
} from "./../files/filesApiTypes";
import { LoggerToDb } from "./../logging";
import { TempUrl } from "./../models/tempUrl";
import { AuthUser } from "./../util";
import { TempUrlService } from "./tempUrl.service";
import {
	TempURLGenerateOptions,
	TempURLGenerateResponse,
	TempURLSaveRequest,
} from "./tempUrlApiTypes";
import { IncomingHttpHeaders } from "http";

@Controller("temp")
@ApiTags("Temporary URLs")
export class TempUrlConstoller {
	constructor(
		private readonly tempUrlService: TempUrlService,
		@Inject() private readonly logger: LoggerToDb
	) { }

	@Post("generate")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: TempURLGenerateResponse })
	public async generate(
		@Headers() headers: IncomingHttpHeaders,
		@Req() request: Request,
		@AuthUser() userId: number,
		@Body() options: TempURLGenerateOptions
	): Promise<TempURLGenerateResponse> {
		try {
			request.headers
			return {
				url: await this.tempUrlService.generate(
					headers,
					userId,
					options.filepath,
					options.max_requests,
					options.expires_at,
					options.is_readonly
				),
			};
		} catch (e) {
			this.logger.logException(e);
			return {
				url: "",
			};
		}
	}

	@Get(":tempUrl/get")
	public async get(@Param("tempUrl") tempUrl: string, @Res() res: Response) {
		try {
			const file = await this.tempUrlService.asStream(tempUrl);
			res.set({
				"Content-Disposition": `filename="${file.filename}"`,
				"Content-Type": file.info.mime,
			});
			file.stream.pipe(res);
			return;
		} catch (e) {
			this.logger.logException(e);
			res.send({
				errors: [{ field: "url", message: (<Error>e).message }],
			});
		}
	}

	@Patch(":tempUrl/save")
	@ApiResponse({ type: OperationStatusResponse })
	public async save(
		@Param("tempUrl") tempUrl: string,
		@Body() body: TempURLSaveRequest
	): Promise<OperationStatusResponse> {
		try {
			await this.tempUrlService.save(tempUrl, body.content, body.append);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} catch (e) {
			this.logger.warn(e.message);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "url", message: (<Error>e).message }],
			};
		}
	}

	@Get("list")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: [TempUrl] })
	public async list(@AuthUser() userId: number) {
		try {
			return await this.tempUrlService.all(userId);
		} catch (e) {
			this.logger.logException(e);
			return [];
		}
	}

	@Delete("delete/:key")
	@UseGuards(AuthGuard("jwt"))
	@ApiParam({ name: "key", type: String })
	@ApiResponse({ type: OperationStatusResponse })
	public async delete(
		@Param("key") key,
		@AuthUser() userId: number
	): Promise<OperationStatusResponse> {
		try {
			await this.tempUrlService.delete(userId, key);
			return {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			};
		} catch (e) {
			this.logger.logException(e);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}
}
