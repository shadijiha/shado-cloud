import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
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
}
