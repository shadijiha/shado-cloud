import {
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	Post,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { LoggerToDb } from "src/logging";
import { Log } from "src/models/log";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.strategy";

@Controller("admin")
@ApiTags("admin")
@UseGuards(AuthGuard("jwt"), AdminGuard)
export class AdminController {
	constructor(
		private readonly adminService: AdminService,
		@Inject() private readonly logger: LoggerToDb
	) {}

	@Get("logs")
	@ApiResponse({ type: [Log] })
	async logs() {
		try {
			return await this.adminService.all();
		} catch (e) {
			this.logger.logException(e);
			return [];
		}
	}

	@Get("logInfo")
	async logInfo() {
		this.logger.log(
			"This is a debug log to test logging"
		);
	}

	@Delete("delete/:id")
	@ApiParam({
		name: "id",
		description: "An ID or array of ids of the logs you want to delete",
	})
	async delete(@Param("id") id: string) {
		let ids: number[] = [];

		// See if prameter is a number
		const data = decodeURIComponent(id);

		if (data.includes("[")) {
			let buffer = data.replace("[", "").replace("]", "").split(",");

			try {
				buffer.forEach((e) => {
					ids.push(parseInt(e));
				});
			} catch (e) {
				this.logger.logException(e);
			}
		} else {
			try {
				ids = [parseInt(data)];
			} catch (e) {
				this.logger.logException(e);
			}
		}

		this.adminService
			.deleteByIds(ids)
			.catch((e) => this.logger.logException(e));
	}

	@Post("redeploy")
	async redeploy() {
		return await this.adminService.redeploy();
	}
}
