import {
	ExceptionFilter,
	Catch,
	ArgumentsHost,
	HttpException,
	UnauthorizedException,
	Inject,
} from "@nestjs/common";
import { Request, Response } from "express";
import { LoggerToDb } from "./logging";
import { SoftException } from "./util";

@Catch(Error)
export class GlobalExceptionFilter implements ExceptionFilter {
	public constructor(
		@Inject() private readonly logger: LoggerToDb,
	) {}

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
			this.logger.logException(exception);
		}
		response.status(status).json({
			statusCode: status,
			timestamp: new Date().toISOString(),
			path: request.url,
			message: exception.message,
		});
	}
}
