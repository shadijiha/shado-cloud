import "reflect-metadata";
import { ConsoleLogger, Injectable } from "@nestjs/common";
import { RequestContext } from "nestjs-request-context";
import { type Request } from "express";
import { getUserIdFromRequest, SoftException } from "./util";
import { OperationStatus, type OperationStatusResponse } from "./files/filesApiTypes";
import { ConfigService } from "@nestjs/config";
import { EnvVariables, ReplicationRole } from "./config/config.validator";

type StructuredLevel = "error" | "warn" | "info" | "debug" | "verbose";

/**
 * Application logger. Replaces the old `AppLogger` (which persisted every log line to MySQL).
 *
 * Instead of writing to a database, this emits a single structured JSON line per log to stdout,
 * enriched with the same request-scoped context the old logger captured (route, userId, client
 * IP, user-agent, controller/context, stack, replica role). The Vector collector tails stdout,
 * parses the JSON, and ships it to VictoriaLogs — so logs are queried in Grafana (LogsQL) rather
 * than in a MySQL table.
 *
 * It extends {@link ConsoleLogger} and is registered as the global Nest logger (see main.ts), so
 * framework logs get the same JSON treatment. `logException` / `errorWrapper` are kept because
 * they're used across many controllers/services.
 */
@Injectable()
export class AppLogger extends ConsoleLogger {
   constructor(
      context: string,
      private readonly configService?: ConfigService<EnvVariables>,
   ) {
      super(context);
   }

   public logException(e: Error): void {
      // SoftExceptions are expected/handled control-flow and intentionally not logged.
      if (e instanceof SoftException) return;
      this.error(e.message, e.stack);
   }

   public async errorWrapper(func: () => any): Promise<any | OperationStatusResponse> {
      try {
         const data = await func();
         return (
            data || {
               status: OperationStatus[OperationStatus.SUCCESS],
               errors: [],
            }
         );
      } catch (e) {
         this.logException(e as Error);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   // Nest's LoggerService signatures pass an optional trailing `context` string; app code calls
   // these with just a message (and, for error, a stack). Both are supported.
   public log(message: any, context?: string): void {
      this.emit("info", message, { context });
   }

   public warn(message: any, context?: string): void {
      this.emit("warn", message, { context });
   }

   public error(message: any, stack?: string, context?: string): void {
      this.emit("error", message, { stack, context });
   }

   public debug(message: any, context?: string): void {
      this.emit("debug", message, { context });
   }

   public verbose(message: any, context?: string): void {
      this.emit("verbose", message, { context });
   }

   /**
    * Builds the structured record and writes exactly one JSON line to stdout. Never throws —
    * logging must not break request handling.
    */
   private emit(level: StructuredLevel, message: any, opts?: { stack?: string; context?: string }): void {
      try {
         const req: Request | undefined = RequestContext.currentContext?.req;

         const record: Record<string, any> = {
            timestamp: new Date().toISOString(),
            level,
            service: "shado-cloud",
            context: opts?.context ?? this.context,
            message: typeof message === "string" ? message : this.safeStringify(message),
         };

         if (this.configService?.get("this-service.replication.role", { infer: true }) === ReplicationRole.Replica) {
            record.role = "replica";
         }

         if (req) {
            record.route = req.originalUrl;
            const ip = this.getIp(req);
            if (ip) record.ip = ip;
            const ua = req.headers?.["user-agent"];
            if (ua) record.userAgent = Array.isArray(ua) ? ua.join(",") : ua;
            const userId = getUserIdFromRequest(req);
            if (userId !== -1) record.userId = userId;
         }

         if (opts?.stack) record.stack = opts.stack;

         process.stdout.write(JSON.stringify(record) + "\n");
      } catch (e) {
         // Last-resort fallback: logging must never throw.
         try {
            process.stdout.write(
               JSON.stringify({ level, service: "shado-cloud", message: String(message), loggerError: (e as Error).message }) + "\n",
            );
         } catch {
            /* give up silently */
         }
      }
   }

   private getIp(req: Request): string | undefined {
      try {
         if (!req?.ip) return undefined;
         if (req.ip.includes("127.0.0.1") || req.ip.includes("localhost") || req.ip === "::1") {
            const ips = req.headers["x-forwarded-for"];
            return Array.isArray(ips) ? ips.join(",") : ips;
         }
         return req.ip;
      } catch {
         return undefined;
      }
   }

   private safeStringify(v: any): string {
      try {
         return typeof v === "object" ? JSON.stringify(v) : String(v);
      } catch {
         return String(v);
      }
   }
}
