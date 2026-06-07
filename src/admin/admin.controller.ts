import {
   Body,
   Controller,
   Delete,
   Get,
   HttpException,
   HttpStatus,
   Inject,
   Param,
   Post,
   Put,
   UseGuards,
   ParseEnumPipe,
   Patch,
   UsePipes,
   Res,
   StreamableFile,
   Query,
   UseInterceptors,
   UploadedFile,
   All,
   Req,
   Sse,
   MessageEvent,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { ApiBody, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { LoggerToDb } from "src/logging";
import { Log } from "src/models/log";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.strategy";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { FeatureFlagService } from "./feature-flag.service";
import { CreateFeatureFlagRequest, DatabaseGetTableRequest, UpdateFeatureFlagRequest } from "./adminApiTypes";
import { REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY } from "./remote.constants";
import { ValidationPipeline } from "src/auth/ValidationPipeline";
import { isDev, AuthUser } from "src/util";
import { AuthService } from "src/auth/auth.service";
import { TwoFactorGuard, Require2fa } from "./two-factor.guard";
import { isStepUpScope, STEP_UP_TTL_SECONDS } from "./step-up.constants";

/**
 * Each function of this controller needs to be decorated with
 * @UseGuards(JwtAuthGuard, AdminGuard)
 * The reason it is not being used on the controller, is because redeploy needs to be public
 */
@Controller("admin")
@ApiTags("admin")
export class AdminController {
   constructor(
      private readonly adminService: AdminService,
      private readonly logger: LoggerToDb,
      private readonly config: ConfigService<EnvVariables>,
      private readonly featureFlagService: FeatureFlagService,
      private readonly authService: AuthService,
   ) { }

   @Get("logs")
   @ApiResponse({ type: [Log] })
   @UseGuards(JwtAuthGuard, AdminGuard)
   async logs(@Query("type") type?: string) {
      try {
         const types = type ? type.split(",") : undefined;
         return await this.adminService.all(types);
      } catch (e) {
         this.logger.logException(e as Error);
         return [];
      }
   }

   @Get("logInfo")
   @UseGuards(JwtAuthGuard, AdminGuard)
   async logInfo() {
      this.logger.log("This is a debug log to test logging");
   }

   @Delete("delete")
   @UseGuards(JwtAuthGuard, AdminGuard)
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

   /**
    * Feature flag endpoints
    */
   @Get("featureFlags")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public getFeatureFlags() {
      return this.featureFlagService.getFeatureFlags();
   }

   @Get("featureFlags/:namespace")
   @ApiParam({
      name: "namespace",
      description: "Feature flag namespace",
      enum: FeatureFlagNamespace,
   })
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
   public disableFeatureFlag(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ) {
      return this.featureFlagService.disableFeatureFlag(namespace, key);
   }

   @Post("featureFlag")
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
   @Require2fa("database")
   public getTables() {
      return this.adminService.getTables();
   }

   @Post("database/db/tables/:table/select")
   @ApiParam({
      name: "table",
      description: "Table name",
   })
   @UsePipes(new ValidationPipeline())
   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
   @Require2fa("database")
   public getTable(@Param("table") table: string, @Body() body: DatabaseGetTableRequest) {
      return this.adminService.getTable(table, body);
   }

   @Get("database/db/tables/:table/count")
   @ApiParam({ name: "table", description: "Table name" })
   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
   @Require2fa("database")
   public getTableCount(@Param("table") table: string) {
      return this.adminService.getTableCount(table);
   }

   @Delete("database/db/tables/:table/row/:id")
   @ApiParam({ name: "table", description: "Table name" })
   @ApiParam({ name: "id", description: "Row primary key" })
   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
   @Require2fa("database")
   public deleteRow(@Param("table") table: string, @Param("id") id: string) {
      return this.adminService.deleteRow(table, id);
   }

   @Patch("database/db/tables/:table/row/:id")
   @ApiParam({ name: "table", description: "Table name" })
   @ApiParam({ name: "id", description: "Row primary key" })
   @UseGuards(JwtAuthGuard, AdminGuard, TwoFactorGuard)
   @Require2fa("database")
   public updateRow(@Param("table") table: string, @Param("id") id: string, @Body() body: Record<string, any>) {
      return this.adminService.updateRow(table, id, body);
   }

   /**
    * Server setup backup endpoint
    */
   @Post("server-setup")
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
   public serverSetupStream(): Observable<MessageEvent> {
      return this.adminService.generateServerSetupBackupStream();
   }

   @Sse("cloud-backup/stream")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public cloudBackupStream(): Observable<MessageEvent> {
      return this.adminService.generateCloudBackupStream();
   }

   @Get("backup/download")
   @UseGuards(JwtAuthGuard, AdminGuard)
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
   @UseGuards(JwtAuthGuard, AdminGuard)
   @UseInterceptors(FileInterceptor("file"))
   public uploadBackground(@UploadedFile() file: Express.Multer.File) {
      return this.adminService.uploadBackgroundImage(file);
   }

   @Delete("backgrounds/:filename")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public deleteBackground(@Param("filename") filename: string) {
      return this.adminService.deleteBackgroundImage(filename);
   }

   // Invalidate all thumbnails
   @Post("invalidate_thumbnails")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public invalidateThumbnails() {
      return this.adminService.invalidateThumbnails();
   }

   @Get("version")
   @UseGuards(JwtAuthGuard, AdminGuard)
   async getVersion() {
      const { version } = await import("../../package.json");
      return { version, env: isDev(this.config) ? "dev" : "prod" };
   }

   /**
    * Reusable step-up 2FA gate. `scope` is e.g. "remote", "database", "redis".
    */
   @Get("2fa/status/:scope")
   @UseGuards(JwtAuthGuard, AdminGuard)
   async stepUpStatus(@AuthUser() userId: number, @Param("scope") scope: string) {
      if (!isStepUpScope(scope)) {
         throw new HttpException("Unknown scope", HttpStatus.BAD_REQUEST);
      }
      const user = await this.authService.getById(userId);
      if (!user) return { twoFactorEnabled: false, active: false, expiresInSeconds: 0 };

      const [twoFactorEnabled, active] = await Promise.all([
         this.authService.isTotpEnabled(user.shadoUserId),
         this.authService.hasStepUp(user.shadoUserId, scope),
      ]);
      const expiresInSeconds = active ? await this.authService.stepUpTtl(user.shadoUserId, scope) : 0;
      return { twoFactorEnabled, active, expiresInSeconds };
   }

   @Post("2fa/verify/:scope")
   @UseGuards(JwtAuthGuard, AdminGuard)
   async stepUpVerify(@AuthUser() userId: number, @Param("scope") scope: string, @Body() body: { code?: string }) {
      if (!isStepUpScope(scope)) {
         throw new HttpException("Unknown scope", HttpStatus.BAD_REQUEST);
      }
      const code = (body?.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) {
         return { success: false, errors: [{ field: "code", message: "Enter the 6-digit code" }] };
      }

      const user = await this.authService.getById(userId);
      if (!user) {
         return { success: false, errors: [{ field: "code", message: "User not found" }] };
      }

      const ok = await this.authService.verifyTotp(user.shadoUserId, code);
      if (!ok) {
         return { success: false, errors: [{ field: "code", message: "Invalid authentication code" }] };
      }

      await this.authService.grantStepUp(user.shadoUserId, scope);
      return { success: true, expiresInSeconds: STEP_UP_TTL_SECONDS };
   }

   @All("whep/*")
   @UseGuards(JwtAuthGuard, AdminGuard)
   async whepProxy(@Req() req: Request, @Res() res: Response) {
      // Same feature flag that gates the remote desktop/terminal gateways.
      if (await this.featureFlagService.isFeatureFlagDisabled(REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY)) {
         res.status(403).send("Remote access is disabled by a feature flag");
         return;
      }

      // Require a valid 2FA remote-access grant.
      const grantUser = await this.authService.getById((req as any).authUserId);
      if (!grantUser || !(await this.authService.hasStepUp(grantUser.shadoUserId, "remote"))) {
         res.status(403).send("Remote access requires 2FA verification");
         return;
      }

      const subPath = req.url.replace(/^\/admin\/whep/, "");
      const url = `http://127.0.0.1:8889${subPath}`;

      // Read raw body since SDP is not JSON
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      const resp = await fetch(url, {
         method: req.method,
         headers: { "Content-Type": req.headers["content-type"] || "application/sdp" },
         body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      resp.headers.forEach((v, k) => {
         if (k.toLowerCase() === "access-control-allow-origin") return;
         res.setHeader(k, v);
      });
      const origin = req.headers.origin;
      if (origin) {
         res.setHeader("Access-Control-Allow-Origin", origin);
         res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      res.status(resp.status).send(Buffer.from(await resp.arrayBuffer()));
   }
}
