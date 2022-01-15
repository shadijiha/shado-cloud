/**
 * Utlity functions
 */
import { createParamDecorator, ExecutionContext, Logger } from "@nestjs/common";
import { ApiBody } from "@nestjs/swagger";
import { Request } from "express";
import { CookiePayload } from "./auth/authApiTypes";

/**
 * @example Use this function as decorator on top of controller functions
 * @returns Returns the logged in user
 */
export const AuthUser = createParamDecorator(
	(data: unknown, ctx: ExecutionContext) => {
		const request = <Request>ctx.switchToHttp().getRequest();
		const payload = <CookiePayload>(
			parseJwt(request.cookies[process.env.COOKIE_NAME])
		);

		return payload.userId;
	}
);

export const ApiFile =
	(fileName: string = "file"): MethodDecorator =>
	(target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
		ApiBody({
			schema: {
				type: "object",
				properties: {
					dest: {
						type: "string",
					},
					[fileName]: {
						type: "string",
						format: "binary",
					},
				},
			},
		})(target, propertyKey, descriptor);
	};

/**
 * Parses the JWT token sent as cookie
 * @param token The token to parse
 * @returns Returns the json object with the JWT data
 */
export function parseJwt(token) {
	var base64Url = token.split(".")[1];
	var base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
	var jsonPayload = decodeURIComponent(
		Buffer.from(base64, "base64")
			.toString()
			.split("")
			.map(function (c) {
				return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
			})
			.join("")
	);

	return JSON.parse(jsonPayload);
}

interface Enum {
	[id: number]: string;
}

/**
 * Converts an enum to array of string
 * @param _enum The enum type
 * @returns Returns all the values names of the enum
 */
export function enumToArray(_enum: Enum): string[] {
	return Object.values(_enum)
		.filter((value) => typeof value === "string")
		.map((value) => value as string);
}
