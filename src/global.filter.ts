import {
   type ExceptionFilter,
   Catch,
   type ArgumentsHost,
   HttpException,
   UnauthorizedException,
   Inject,
} from "@nestjs/common";
import { type Request, type Response } from "express";
import { LoggerToDb } from "./logging";
import { SoftException } from "./util";
import { MetricsPusherService } from "./metrics-pusher.service";

@Catch(Error)
export class GlobalExceptionFilter implements ExceptionFilter {
   public constructor(
      @Inject() private readonly logger: LoggerToDb,
      private readonly metricsPusher?: MetricsPusherService,
   ) {}

   catch(exception: Error, host: ArgumentsHost) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<Response>();
      const request = ctx.getRequest<Request>();
      let status = exception instanceof HttpException ? exception.getStatus() : 400;
      if (exception instanceof UnauthorizedException) status = 401;

      // Track unauthorized errors
      if (status === 401) {
         const ip = (request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] || request.ip || "unknown") as string;
         const route = `${request.method} ${request.baseUrl || ""}${request.path}`.replace(/\/[0-9a-f-]{20,}/gi, "/:id");
         this.metricsPusher?.recordUnauthorized(ip.split(",")[0].trim(), route);
      }

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
