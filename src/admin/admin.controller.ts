import {
	Controller,
	Delete,
	Get,
	HttpException,
	HttpStatus,
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
import { AppMetricsService } from "./app-metrics.service";

@Controller("admin")
@ApiTags("admin")
@UseGuards(AuthGuard("jwt"), AdminGuard)
export class AdminController {
	constructor(
		private readonly adminService: AdminService,
		private readonly metrics: AppMetricsService,
		@Inject() private readonly logger: LoggerToDb
	) { }

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
			let buffer = data.replace(/\[/g, "").replace(/\]/g, "").split(",");
			buffer.forEach((e) => {
				const int = parseInt(e);
				if (!isNaN(int)) ids.push(int);
			});
		} else {
			const int = parseInt(data);
			if (isNaN(int)) {
				const message = "Invalid ID: " + data;
				this.logger.error(message);
				throw new HttpException(message, HttpStatus.BAD_REQUEST);
			}
			ids = [parseInt(data)];
		}

		this.adminService
			.deleteByIds(ids)
			.catch((e) => this.logger.logException(e));
	}

	@Post("redeploy")
	async redeploy() {
		return await this.adminService.redeploy();
	}

	@Get("redis/info/:section")
	@ApiParam({
		name: "section",
		description: "Redis info section name",
	})
	public redisInfo(@Param("section") section: string | undefined) {
		return this.metrics.redisInfo(section);
	}

	@Get("redis/dump")
	public redisDumb() {
		return this.metrics.dumpRedisCache();
	}
}
