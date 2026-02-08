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
   Put,
   UseGuards,
   Headers,
   UnauthorizedException,
   ParseEnumPipe,
   Patch,
   UsePipes,
   Res,
   StreamableFile,
   Sse,
   MessageEvent,
   Query,
   UseInterceptors,
   UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { Observable } from "rxjs";
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
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { FeatureFlagService } from "./feature-flag.service";
import { CreateFeatureFlagRequest, DatabaseGetTableRequest, UpdateFeatureFlagRequest } from "./adminApiTypes";
import { ValidationPipeline } from "src/auth/ValidationPipeline";
import { DeploymentService } from "./deployment.service";
import * as fs from "fs";
import * as path from "path";

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
      private readonly logger: LoggerToDb,
      private readonly config: ConfigService<EnvVariables>,
      private readonly featureFlagService: FeatureFlagService,
      private readonly deploymentService: DeploymentService,
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
      if (!Array.isArray(body.ids)) {
         throw new HttpException("The 'ids' field must be a non-empty array.", HttpStatus.BAD_REQUEST);
      }

      let ids: number[] = body.ids.map((id) => parseInt(id)).filter((id) => !isNaN(id));
      if (ids.length == 0) {
         throw new HttpException("Invalid ids", HttpStatus.BAD_REQUEST);
      }

      this.adminService.deleteByIds(ids).catch((e) => {
         this.logger.logException(e);
      });
   }

   // Exlude from admin gaurds
   @Post("redeploy/:type")
   @HttpCode(HttpStatus.OK)
   @ApiParam({
      name: "type",
      description: "Type of deployment to trigger",
      enum: ["backend", "frontend"],
   })
   async redeploy(
      @Param("type") type: string,
      @Body() payload: any,
      @Headers("x-hub-signature-256") signature: string,
   ) {
      if (type != "backend" && type != "frontend") {
         throw new HttpException("Invalid deployment type", HttpStatus.BAD_REQUEST);
      }

      const branchName = "master";
      this.logger.log("Received backend webhook payload");

      try {
         // Check that the push is from the correct branch (optional)
         if (payload.ref !== `refs/heads/${branchName}`) {
            this.logger.warn(`Ignoring push to non-${branchName} branch`);
            return { message: `Not a push to ${branchName} branch, ignoring` };
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
         this.deploymentService.startDeployment(type as "backend" | "frontend", "github-webhook");

         return { message: "Deployment triggered successfully" };
      } catch (error) {
         const e = <Error>error;
         this.logger.error("Deployment failed " + e.message, e.stack);
         return { message: e.message };
      }
   }

   @Get("metrics/system")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getSystemMetrics() {
      return this.metrics.getSystemMetrics();
   }

   @Get("redis/info/:section")
   @ApiParam({
      name: "section",
      description: "Redis info section name",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public redisInfo(@Param("section") section: string | undefined) {
      return this.metrics.redisInfo(section);
   }

   @Get("redis/dump")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public redisDumb() {
      return this.metrics.dumpRedisCache();
   }

   /**
    * Feature flag endpoints
    */
   @Get("featureFlags")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getFeatureFlags() {
      return this.featureFlagService.getFeatureFlags();
   }

   @Get("featureFlags/:namespace")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getFeatureFlagsByNamespace(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
   ) {
      return this.featureFlagService.getFeatureFlags(namespace);
   }

   @Get("featureFlag/:namespace/:key")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @ApiParam({
      name: "key",
      description: "Feature flag key",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ) {
      return this.featureFlagService.getFeatureFlag(namespace, key);
   }

   @Patch("featureFlag/:namespace/:key/enable")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @ApiParam({
      name: "key",
      description: "Feature flag key",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public enableFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ) {
      return this.featureFlagService.enableFeatureFlag(namespace, key);
   }

   @Patch("featureFlag/:namespace/:key/disable")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @ApiParam({
      name: "key",
      description: "Feature flag key",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public disableFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ) {
      return this.featureFlagService.disableFeatureFlag(namespace, key);
   }

   @Post("featureFlag")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @UsePipes(new ValidationPipeline())
   public createFeatureFlag(@Body() body: CreateFeatureFlagRequest) {
      return this.featureFlagService.createFeatureFlag(body);
   }

   @Delete("featureFlag/:namespace/:key")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @ApiParam({
      name: "key",
      description: "Feature flag key",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public deleteFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ) {
      return this.featureFlagService.deleteFeatureFlag(namespace, key);
   }

   @Patch("featureFlag/:namespace/:key")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @ApiParam({
      name: "key",
      description: "Feature flag key",
   })
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @UsePipes(new ValidationPipeline())
   public updateFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
      @Body() body: UpdateFeatureFlagRequest,
   ) {
      return this.featureFlagService.updateFeatureFlag(namespace, key, body);
   }

   /**
    * Database endpoints
    */
   @Get("database/db/tables")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getTables() {
      return this.adminService.getTables();
   }

   @Post("database/db/tables/:table/select")
   @ApiParam({
      name: "table",
      description: "Table name",
   })
   @UsePipes(new ValidationPipeline())
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getTable(@Param("table") table: string, @Body() body: DatabaseGetTableRequest) {
      return this.adminService.getTable(table, body);
   }

   /**
    * Server setup backup endpoint
    */
   @Post("server-setup")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async getServerSetup(
      @Body() body: { sudoPassword?: string },
      @Res({ passthrough: true }) res: Response,
   ): Promise<StreamableFile> {
      const result = await this.adminService.generateServerSetupBackup(body.sudoPassword);
      
      res.set({
         "Content-Type": "application/zip",
         "Content-Disposition": `attachment; filename="server-setup-${Date.now()}.zip"`,
      });
      
      return new StreamableFile(result);
   }

   @Sse("server-setup/stream")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public serverSetupStream(): Observable<MessageEvent> {
      return this.adminService.generateServerSetupBackupStream();
   }

   @Sse("cloud-backup/stream")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public cloudBackupStream(): Observable<MessageEvent> {
      return this.adminService.generateCloudBackupStream();
   }

   @Get("backup/download")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async downloadBackup(
      @Query("file") file: string,
      @Res() res: Response,
   ) {
      const filePath = file; // Already decoded by NestJS
      const stream = await this.adminService.getBackupFile(filePath);
      const filename = filePath.split("/").pop();
      
      res.set({
         "Content-Type": "application/zip",
         "Content-Disposition": `attachment; filename="${filename}"`,
      });
      
      stream.pipe(res);
      stream.on("close", () => {
         this.adminService.deleteBackupFile(filePath);
      });
   }

   /**
    * Background images endpoints
    */
   @Get("backgrounds")
   public getBackgrounds() {
      return this.adminService.getBackgroundImages();
   }

   @Get("backgrounds/:filename")
   public async getBackgroundImage(
      @Param("filename") filename: string,
      @Res() res: Response,
   ) {
      const stream = await this.adminService.getBackgroundImageStream(filename);
      const ext = filename.split(".").pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
         jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif"
      };
      res.set({ "Content-Type": mimeTypes[ext || "jpg"] || "image/jpeg" });
      stream.pipe(res);
   }

   @Post("backgrounds")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @UseInterceptors(FileInterceptor("file"))
   public uploadBackground(@UploadedFile() file: Express.Multer.File) {
      return this.adminService.uploadBackgroundImage(file);
   }

   @Delete("backgrounds/:filename")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public deleteBackground(@Param("filename") filename: string) {
      return this.adminService.deleteBackgroundImage(filename);
   }

   // Deployment Pipeline
   @Get("deployment/status")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async getDeploymentStatus() {
      return {
         isRunning: await this.deploymentService.isRunning(),
         current: await this.deploymentService.getCurrentDeployment(),
         last: await this.deploymentService.getLastDeployment(),
      };
   }

   @Get("deployment/stream")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @Sse()
   public streamDeployment(): Observable<MessageEvent> {
      const subject = this.deploymentService.getSubject();
      if (!subject) {
         throw new HttpException("No deployment in progress", HttpStatus.NOT_FOUND);
      }
      return subject.asObservable();
   }

   @Get("deployment/start/:project")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @Sse()
   public async startDeployment(
      @Param("project") project: "backend" | "frontend",
   ): Promise<Observable<MessageEvent>> {
      if (project !== "backend" && project !== "frontend") {
         throw new HttpException("Invalid project", HttpStatus.BAD_REQUEST);
      }
      const subject = await this.deploymentService.startDeployment(project, "admin");
      return subject.asObservable();
   }

   @Post("deployment/cancel")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public async cancelDeployment(): Promise<{ success: boolean }> {
      await this.deploymentService.cancelDeployment();
      return { success: true };
   }

   @Post("deployment/retry/:step")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   @Sse()
   public async retryStep(@Param("step") step: string): Promise<Observable<MessageEvent>> {
      const subject = await this.deploymentService.retryStep(step as any);
      return subject.asObservable();
   }

   // Environment file management
   @Get("env/:project")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public getEnvFile(@Param("project") project: "backend" | "frontend"): string {
      const envPath = project === "backend" 
         ? path.join(process.cwd(), ".env")
         : path.join(this.config.get("FRONTEND_DEPLOY_PATH") || "", ".env");
      
      if (!fs.existsSync(envPath)) {
         throw new HttpException("Env file not found", HttpStatus.NOT_FOUND);
      }
      return fs.readFileSync(envPath, "utf-8");
   }

   @Put("env/:project")
   @UseGuards(AuthGuard("jwt"), AdminGuard)
   public saveEnvFile(
      @Param("project") project: "backend" | "frontend",
      @Body("content") content: string,
   ): { success: boolean } {
      const envPath = project === "backend" 
         ? path.join(process.cwd(), ".env")
         : path.join(this.config.get("FRONTEND_DEPLOY_PATH") || "", ".env");
      
      if (project === "frontend" && !this.config.get("FRONTEND_DEPLOY_PATH")) {
         throw new HttpException("FRONTEND_DEPLOY_PATH not configured", HttpStatus.BAD_REQUEST);
      }
      
      fs.writeFileSync(envPath, content, "utf-8");
      this.logger.log(`Env file updated for ${project}`);
      return { success: true };
   }
}
