import {
	ExceptionFilter,
	Catch,
	ArgumentsHost,
	HttpException,
	Logger,
	UnauthorizedException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { CookiePayload } from "./auth/authApiTypes";
import { errorLog } from "./logging";
import { parseJwt, SoftException } from "./util";

@Catch(Error)
export class GlobalExceptionFilter implements ExceptionFilter {
	catch(exception: Error, host: ArgumentsHost) {
		const ctx = host.switchToHttp();
		const response = ctx.getResponse<Response>();
		const request = ctx.getRequest<Request>();
		let status =
			exception instanceof HttpException ? exception.getStatus() : 400;
		if (exception instanceof UnauthorizedException) status = 401;

		// Log it
		if (
			!(
				exception instanceof HttpException ||
				exception instanceof UnauthorizedException ||
				exception instanceof SoftException
			)
		) {
			const userId = (<CookiePayload>(
				parseJwt(request.cookies[process.env.COOKIE_NAME])
			))?.userId;
			errorLog(exception, GlobalExceptionFilter, userId);
		}
		response.status(status).json({
			statusCode: status,
			timestamp: new Date().toISOString(),
			path: request.url,
			message: exception.message,
		});
	}
}
