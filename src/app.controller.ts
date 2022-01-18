import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";
import { errorLog } from "./logging";

@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@Get()
	getHello(): string {
		try {
			return this.appService.getHello();
		} catch (e) {
			errorLog(e, AppController);
			return "An error has occured";
		}
	}
}
