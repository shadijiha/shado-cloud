import {
	Controller,
	Delete,
	Get,
	Logger,
	Param,
	Post,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { errorLog, infoLog } from "src/logging";
import { Log } from "src/models/log";
import { AuthUser } from "src/util";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.strategy";

@Controller("admin")
@ApiTags("admin")
@UseGuards(AuthGuard("jwt"), AdminGuard)
export class AdminController {
	constructor(private readonly adminService: AdminService) {}

	@Get("logs")
	@ApiResponse({ type: [Log] })
	async logs(@AuthUser() userId: number) {
		try {
			return await this.adminService.all();
		} catch (e) {
			errorLog(e, AdminController, userId);
			return [];
		}
	}

	@Get("logInfo")
	async logInfo(@AuthUser() userId: number) {
		await infoLog(
			new Error("This is a debug log to test logging"),
			AdminController,
			userId
		);
	}

	@Delete("delete/:id")
	@ApiParam({
		name: "id",
		description: "An ID or array of ids of the logs you want to delete",
	})
	async delete(@AuthUser() userId: number, @Param("id") id: string) {
		let ids: number[] = [];

		// See if prameter is a number
		const data = decodeURIComponent(id);

		if (data.includes("[")) {
			let buffer = data.replace("[", "").replace("]", "").split(",");

			try {
				buffer.forEach((e) => {
					ids.push(Number(e));
				});
			} catch (e) {
				errorLog(e, AdminController, userId);
			}
		} else {
			try {
				ids = [parseInt(data)];
			} catch (e) {
				errorLog(e, AdminController, userId);
			}
		}

		this.adminService
			.deleteByIds(ids)
			.catch((e) => errorLog(e, AdminController, userId));
	}

	@Post("redeploy")
	async redeploy() {
		return await this.adminService.redeploy();
	}
}
