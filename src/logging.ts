import { PATH_METADATA } from "@nestjs/common/constants";
import { Logger } from "@nestjs/common";
import { Log } from "./models/log";
import { User } from "./models/user";

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
	log.route = getRoute(source);
	log.type = type;

	// Get user
	if (userId) {
		const user = await User.findOne({ where: { id: userId } });
		if (user) {
			log.user = user;
		}
	}

	log.save();
}

function getRoute(controller: Function) {
	let routePath = Reflect.getMetadata(PATH_METADATA, controller);
	routePath +=
		"/" + Reflect.getMetadata(PATH_METADATA, controller.prototype.serveStatic);
	return routePath;
}
