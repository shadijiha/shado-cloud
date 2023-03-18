import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { Log } from "./models/log";
import { User } from "./models/user";
import { RequestContext } from "nestjs-request-context";
import { Request } from "express";
import { SoftException } from "./util";
import { OperationStatus } from "./files/filesApiTypes";

export async function errorWrapper(
	func: () => any,
	controller: Function,
	userId?: number
) {
	try {
		const data = await func();
		return (
			data || {
				status: OperationStatus[OperationStatus.SUCCESS],
				errors: [],
			}
		);
	} catch (e) {
		errorLog(e, controller, userId);
		return {
			status: OperationStatus[OperationStatus.FAILED],
			errors: [{ field: "", message: (<Error>e).message }],
		};
	}
}

export function errorLog(e: Error | any, source: Function, userId?: number) {
	logHelper(e, source, "error", userId);
}

export function warnLog(e: Error | any, source: Function, userId?: number) {
	logHelper(e, source, "warn", userId);
}

export function infoLog(e: Error | any, source: Function, userId?: number) {
	logHelper(e, source, "info", userId);
}

async function logHelper(
	e: Error,
	source: Function,
	type: "error" | "info" | "warn",
	userId?: number
) {
	// IF it is a softexception, don't log it
	if (e instanceof SoftException) return;

	const ctx = RequestContext.currentContext;
	switch (type) {
		case "error":
			Logger.error(e.message, e.stack, ctx);
			break;
		case "info":
			Logger.log(e.message, e.stack, ctx);
			break;
		case "warn":
			Logger.warn(e.message, e.stack, ctx);
			break;
	}
	const log = new Log();
	log.message = e.message;
	log.controller = source.name;
	log.route = getRoute();
	log.type = type;
	log.userAgent = getUserAgent();
	log.ipAddress = getIp() || "localhost";

	// Get user
	if (userId) {
		const user = await User.findOne({ where: { id: userId } });
		if (user) {
			log.user = user;
		}
	}

	log.save();
}

function getRoute() {
	try {
		const req: Request = RequestContext.currentContext.req;
		let routePath = req.originalUrl;
		return routePath;
	} catch (e) {
		Logger.debug((e as Error).message);
	}
}

function getUserAgent() {
	try {
		const req: Request = RequestContext.currentContext.req;
		return req.headers["user-agent"];
	} catch (e) {
		Logger.debug((e as Error).message);
	}
}

function getIp() {
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
		Logger.debug((e as Error).message);
	}
}
