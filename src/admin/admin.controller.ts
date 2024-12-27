import {
   Body,
   Controller,
   Delete,
   Get,
   HttpCode,
   HttpException,
   HttpStatus,
   Inject,
   Param,
   Post,
   UseGuards,
   Headers,
   UnauthorizedException,
   Req,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBody, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { LoggerToDb } from "src/logging";
import { Log } from "src/models/log";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.strategy";
import { AppMetricsService } from "./app-metrics.service";
import crypto from "crypto";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { Request } from "express";

/**
 * Each function of this controller needs to be decorated with
 * @UseGuards(AuthGuard("jwt"), AdminGuard)
 * The reason it is not being used on the controller, is because redeploy needs to be public
 */
@Controller("admin")
@ApiTags("admin")
export class AdminController {
   constructor(
      private readonly adminService: AdminService,
      private readonly metrics: AppMetricsService,
      @Inject() private readonly logger: LoggerToDb,
      private readonly config: ConfigService<EnvVariables>,
   ) {}

   @Get("logs")
   @ApiResponse({ type: [Log] })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   async logs() {
      try {
         return await this.adminService.all();
      } catch (e) {
         this.logger.logException(e);
         return [];
      }
   }

   @Get("logInfo")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   async logInfo() {
      this.logger.log("This is a debug log to test logging");
   }

   @Delete("delete")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @ApiBody({
      schema: {
         type: "object",
         properties: {
            ids: {
               type: "array",
               items: {
                  type: "string",
               },
               description: "An array of ids of the logs you want to delete",
            },
         },
      },
   })
   public delete(@Body() body: { ids: string[] }) {
      let ids: number[] = body.ids.map((id) => parseInt(id)).filter((id) => !isNaN(id));
      if (ids.length == 0) {
         throw new HttpException("Invalid ids", HttpStatus.BAD_REQUEST);
      }

      this.adminService.deleteByIds(ids).catch((e) => {
         this.logger.logException(e);
      });
   }

   // Exlude from admin gaurds
   @Post("redeploy")
   @HttpCode(HttpStatus.OK)
   @ApiBody({})
   async redeploy(@Body() payload: any, @Headers("x-hub-signature-256") signature: string) {
      // Validate payload (optional: check for GitHub signature for security)
      const branchName = "nest-js-backend";
      this.logger.log("Received webhook payload");

      try {
         // Check that the push is from the correct branch (optional)
         if (payload.ref !== `refs/heads/${branchName}`) {
            this.logger.warn("Ignoring push to non-main branch");
            return { message: "Not a push to main branch, ignoring" };
         }

         // Verify GitHub signature
         const githubSecret = this.config.get<string>("GITHUB_WEBHOOK_SECRET");
         if (!githubSecret) {
            throw new Error("env var GITHUB_WEBHOOK_SECRET is undefined");
         }

         const hash = crypto.createHmac("sha256", githubSecret).update(JSON.stringify(payload)).digest("hex");
         if (`sha256=${hash}` !== signature) {
            this.logger.warn("Invalid signature");
            throw new UnauthorizedException("Invalid signature");
         }

         // Run deployment steps
         this.logger.log("Starting redeployment...");
         await this.adminService.redeploy();

         return { message: "Deployment triggered successfully" };
      } catch (error) {
         const e = <Error>error;
         this.logger.error("Deployment failed " + e.message, e.stack);
         return { message: e.message };
      }
   }

   @Get("redis/info/:section")
   @ApiParam({
      name: "section",
      description: "Redis info section name",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async redisInfo(@Param("section") section: string | undefined) {
      return await this.metrics.redisInfo(section);
   }

   @Get("redis/dump")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async redisDumb() {
      return await this.metrics.dumpRedisCache();
   }
}
