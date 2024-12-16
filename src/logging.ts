import "reflect-metadata";
import { ConsoleLogger, Injectable } from "@nestjs/common";
import { Log } from "./models/log";
import { User } from "./models/user";
import { RequestContext } from "nestjs-request-context";
import { Request } from "express";
import { getUserIdFromRequest, SoftException } from "./util";
import { OperationStatus, OperationStatusResponse } from "./files/filesApiTypes";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

@Injectable()
export class LoggerToDb extends ConsoleLogger {

	constructor(
		context: string,
		@InjectRepository(Log) private readonly logRepo: Repository<Log>,
	) {
		super(context);
	}

	public logException(e: Error): void {
		if (e instanceof SoftException) {
			return;
		} else {
			this.error(e.message, e.stack);
		}
	}

	public async errorWrapper(
		func: () => any
	): Promise<any | OperationStatusResponse> {
		try {
			const data = await func();
			return (
				data || {
					status: OperationStatus[OperationStatus.SUCCESS],
					errors: [],
				}
			);
		} catch (e) {
			this.logException(e);
			return {
				status: OperationStatus[OperationStatus.FAILED],
				errors: [{ field: "", message: (<Error>e).message }],
			};
		}
	}

	public error(message: any, stack?: string): void {
		super.error(message, stack);
		this.logToDb(message, "error", stack);
	}

	public log(message: any): void {
		super.log(message, this.context);
		this.logToDb(message, "info", undefined);
	}

	public warn(message: any): void {
		super.warn(message, this.context);
		this.logToDb(message, "warn", undefined);
	}

	private async logToDb(message: any, logType: Log["type"], stack?: string): Promise<void> {
		const ctx = RequestContext.currentContext;
		const req: Request = ctx.req;

		const log = new Log();
		log.message = message;
		log.controller = this.context;
		log.route = req.originalUrl;
		log.type = logType;
		log.userAgent = "user-agent" in req.headers ? req.headers["user-agent"] : "unknown";
		log.ipAddress = this.getIp() || "localhost";
		log.stack = stack?.substring(0, 512);

		// Get user
		const userId = getUserIdFromRequest(req);
		if (userId != -1) {
			log.user = await User.findOne({ where: { id: userId } });
		}

		this.logRepo.save(log);
	}

	private getIp(): string {
		try {
			const req: Request = RequestContext.currentContext.req;

			if (
				req.ip.includes("127.0.0.1") ||
				req.ip.includes("localhost") ||
				req.ip == "::1"
			) {
				const ips = req.headers["x-forwarded-for"];
				return ips instanceof Array ? (<Array<string>>ips).join(",") : ips;
			} else {
				return req.ip;
			}
		} catch (e) {
			super.debug((e as Error).message);
		}
	}
}
