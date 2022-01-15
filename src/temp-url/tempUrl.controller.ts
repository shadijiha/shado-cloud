import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	Req,
	Res,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiHeader, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import {
	OperationStatus,
	OperationStatusResponse,
} from "src/files/filesApiTypes";
import { TempUrl } from "src/models/tempUrl";
import { AuthUser } from "src/util";
import { TempUrlService } from "./tempUrl.service";
import {
	TempURLGenerateOptions,
	TempURLGenerateResponse,
} from "./tempUrlApiTypes";

@Controller("temp")
@ApiTags("Temporary URLs")
export class TempUrlConstoller {
	constructor(private readonly tempUrlService: TempUrlService) {}

	@Post("generate")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: TempURLGenerateResponse })
	public async generate(
		@Req() request: Request,
		@AuthUser() userId: number,
		@Body() options: TempURLGenerateOptions
	): Promise<TempURLGenerateResponse> {
		const backendurl = request.protocol + "://" + request.get("host");
		return {
			url: await this.tempUrlService.generate(
				userId,
				options.filepath,
				options.max_requests,
				options.expires_at,
				backendurl
			),
		};
	}

	@Get(":tempUrl/get")
	public async get(@Param("tempUrl") tempUrl: string, @Res() res: Response) {
		try {
			const file = await this.tempUrlService.asStream(tempUrl);
			res.set({
				"Content-Disposition": `filename="${file.filename}"`,
			});
			file.stream.pipe(res);
			return;
		} catch (e) {
			res.send({
				errors: [{ field: "url", message: (<Error>e).message }],
			});
		}
	}

	@Get("list")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: [TempUrl] })
	public async list(@AuthUser() userId: number) {
		try {
			return await this.tempUrlService.all(userId);
		} catch (e) {
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
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}
}
