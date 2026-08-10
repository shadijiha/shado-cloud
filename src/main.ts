import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { GlobalExceptionFilter } from "./global.filter";
import helmet from "helmet";
import { AppLogger } from "./logging";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ConfigServiceInterceptor } from "./config/config.interceptor";
import { EnvVariables, ReplicationRole } from "./config/config.validator";
import { isDev } from "./util";
import { buildAllowedOrigins } from "./allowed-origins";
import { ReplicationModule } from "./replication/replication.module";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { MetricsPusherService } from "./metrics-pusher.service";
import yamlConfigLoader from "./config/config.loader";
import { AuthService } from "./auth/auth.service";
import { AdminGuard } from "./admin/admin.strategy";
import { ExecutionContext } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";

async function bootstrap() {
   const replicationRole =  yamlConfigLoader()["this-service"].replication.role;
   const app =
      replicationRole == ReplicationRole.Replica
         ? await NestFactory.create(ReplicationModule)
         : await NestFactory.create(AppModule);
   const envConfig = app.get<ConfigService<EnvVariables>>(ConfigService);

   app.enableCors({
      origin: buildAllowedOrigins(envConfig),
      credentials: true,
   });
   app.useWebSocketAdapter(new IoAdapter(app));
   // Override Nest's default logger so ALL logs (framework + application) are emitted as a single
   // structured JSON line to stdout, which Vector tails and ships to VictoriaLogs. Application
   // code additionally injects AppLogger via DI (which carries the per-class context); this
   // standalone instance handles framework-level logs and doesn't depend on the DI container.
   app.useLogger(new AppLogger("Nest", envConfig));

   const config = new DocumentBuilder()
      .setTitle("Shado Cloud")
      .setDescription(
         "The Shado Cloud API description\n\n" +
         "**Authentication (login, register, logout, me) is handled by the Shado Auth API microservice.**",
      )
      .setVersion("1.0")
      .addTag("")
      .build();

   const document = SwaggerModule.createDocument(app, config);

   // Gate the Swagger UI (/api, /api/*) and spec (/api-json, /api-yaml) behind an
   // authenticated admin session. Previously these were public and leaked the full
   // API surface to anyone.
   //
   // Swagger registers its routes directly on the underlying Express instance rather
   // than as Nest controllers, so `@UseGuards(AdminGuard)` can't be attached to them
   // (there is no Nest ExecutionContext for a guard to hook into). Instead we reuse the
   // real AdminGuard by instantiating it with AuthService and invoking canActivate()
   // through a minimal ExecutionContext adapter — so the admin check stays in one place.
   // Only add admin guard if the AuthService is available (it won't be in the replication module).
   if (replicationRole != ReplicationRole.Replica) {
      const adminGuard = new AdminGuard(app.get(AuthService, { strict: false }));

      const swaggerAdminGuard = async (req: Request, res: Response, next: NextFunction) => {
         // AdminGuard.canActivate only touches ctx.switchToHttp().getRequest(); build the
         // smallest context that satisfies that. It reads req.headers.cookie and (on success)
         // sets req.authUserId.
         const ctx = {
            switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => next }),
         } as unknown as ExecutionContext;

         try {
            if (await adminGuard.canActivate(ctx)) return next();
         } catch {
            // fall through to deny
         }
         // Non-admins are sent to a styled unauthorized page on the frontend instead of
         // seeing a raw status message. Overridable via env for non-prod environments.
         const unauthorizedUrl =
            process.env.API_DOCS_UNAUTHORIZED_URL || "https://cloud.shadijiha.com/api-unauthorized";
         return res.redirect(302, unauthorizedUrl);
      };

      app.use("/api", swaggerAdminGuard);
      app.use("/api-json", swaggerAdminGuard);
      app.use("/api-yaml", swaggerAdminGuard);

      SwaggerModule.setup("api", app, document);
   }

   app.use(helmet());
   app.use(cookieParser());
   app.use(json({ limit: "100mb" }));
   app.use(urlencoded({ extended: true, limit: "100mb" }));
   app.useGlobalInterceptors(new ConfigServiceInterceptor(envConfig));
   if (replicationRole != ReplicationRole.Replica) {
      app.useGlobalFilters(new GlobalExceptionFilter(await app.resolve(AppLogger), app.get(MetricsPusherService)));
   }
   await app.listen(envConfig.get("this-service.port.http", { infer: true }) ?? 9000, "0.0.0.0");
}
bootstrap().catch((err) => {
   console.error("Fatal error during bootstrap:", err);
   process.exit(1);
});
