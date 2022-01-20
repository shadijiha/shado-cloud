import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Logger } from "@nestjs/common";
import { Log } from "./models/log";
import { User } from "./models/user";
import { RequestContext } from "nestjs-request-context";
import { Request } from "express";

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
	switch (type) {
		case "error":
			Logger.error(e.message);
			break;
		case "info":
			Logger.log(e.message);
			break;
		case "warn":
			Logger.warn(e.message);
			break;
	}
	const log = new Log();
	log.message = e.message;
	log.controller = source.name;
	log.route = getRoute();
	log.type = type;
	log.userAgent = getUserAgent();
	log.ipAddress = getIp();

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

		if (req.ip == "127.0.0.1" || req.ip == "localhost" || req.ip == "::1") {
			const ips = req.headers["x-forwarded-for"];
			return ips instanceof Array ? (<Array<string>>ips).join(",") : ips;
		} else {
			return req.ip;
		}
	} catch (e) {
		Logger.debug((e as Error).message);
	}
}
