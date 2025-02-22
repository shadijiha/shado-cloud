import "reflect-metadata";
import { ConsoleLogger, Inject, Injectable } from "@nestjs/common";
import { Log } from "./models/log";
import { User } from "./models/user";
import { RequestContext } from "nestjs-request-context";
import { type Request } from "express";
import { getUserIdFromRequest, SoftException } from "./util";
import { OperationStatus, type OperationStatusResponse } from "./files/filesApiTypes";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { EnvVariables, ReplicationRole } from "./config/config.validator";
import { FeatureFlagNamespace } from "./models/admin/featureFlag";
import { FeatureFlagService } from "./admin/feature-flag.service";

@Injectable()
export class LoggerToDb extends ConsoleLogger {
   constructor(
      context: string,
      @InjectRepository(Log) private readonly logRepo: Repository<Log>,
      @Inject() private readonly featureFlagService: FeatureFlagService,
      private readonly configService: ConfigService<EnvVariables>,
   ) {
      super(context);
   }

   public logException(e: Error): void {
      if (e instanceof SoftException) {
      } else {
         this.error(e.message, e.stack);
      }
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
         this.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   public error(message: any, stack?: string): void {
      message = this.alterMessage(message);
      super.error(message, stack);
      this.logToDb(message, "error", stack);
   }

   public log(message: any): void {
      message = this.alterMessage(message);
      super.log(message, this.context);
      this.logToDb(message, "info", undefined);
   }

   public warn(message: any): void {
      message = this.alterMessage(message);
      super.warn(message, this.context);
      this.logToDb(message, "warn", undefined);
   }

   public async debug(message: any) {
      if (await this.loggingDisabled()) {
         return;
      }
      message = this.alterMessage(message);
      super.debug(message, this.context);
      this.logToDb(message, "debug", undefined);
   }

   private async logToDb(message: any, logType: Log["type"], stack?: string): Promise<void> {
      const ctx = RequestContext.currentContext;
      const req: (Request & { configService: ConfigService<EnvVariables> }) | undefined = ctx?.req;

      const log = new Log();
      log.message = message;
      log.controller = this.context;
      log.route = req?.originalUrl;
      log.type = logType;
      log.userAgent = req && "user-agent" in req.headers ? req.headers["user-agent"] : "unknown";
      log.ipAddress = this.getIp() || "localhost";
      log.stack = stack?.substring(0, 512);

      // Get user
      const userId = getUserIdFromRequest(req);
      if (userId != -1) {
         log.user = await User.findOne({ where: { id: userId } });
      }

      this.logRepo.save(log);
   }

   private async loggingDisabled(): Promise<boolean> {
      // Check if logging is enabled for this context and this log level
      const featureFlag = await this.featureFlagService.getFeatureFlag(
         FeatureFlagNamespace.Log,
         "disabled_log_context",
      );
      if (featureFlag && featureFlag.enabled) {
         try {
            if (JSON.parse(featureFlag.payload).includes(this.context)) {
               return true;
            }
         } catch (e) {
            super.error(`Error parsing feature flag payload: ${(e as Error).message}`);
            return false;
         }
      }
      return false;
   }

   private getIp(): string {
      try {
         const req: Request = RequestContext.currentContext.req;

         if (req.ip.includes("127.0.0.1") || req.ip.includes("localhost") || req.ip == "::1") {
            const ips = req.headers["x-forwarded-for"];
            return ips instanceof Array ? ips.join(",") : ips;
         } else {
            return req.ip;
         }
      } catch (e) {
         super.debug((e as Error).message);
      }
   }

   private alterMessage(message: string): string {
      return `${this.configService.get("REPLICATION_ROLE") == ReplicationRole.Replica ? "[REPLICA]" : ""} ${message}`;
   }
}
