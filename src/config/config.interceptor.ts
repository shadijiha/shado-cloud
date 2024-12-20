import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config.validator";

// Interceptor that attaches ConfigService to the request object
@Injectable()
export class ConfigServiceInterceptor implements NestInterceptor {
   constructor(private configService: ConfigService<EnvVariables>) {}

   intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
      const request = context.switchToHttp().getRequest();
      request.configService = this.configService; // Attach ConfigService to request object

      // Continue with the request lifecycle
      return next.handle().pipe(
         tap(() => {
            delete request.configService; // <-- deleted it from the request to avoid any security issue
         }),
      );
   }
}
