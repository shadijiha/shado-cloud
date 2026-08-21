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
   Sse,
   MessageEvent,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { Observable } from "rxjs";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { ApiBody, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.strategy";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { FeatureFlagService } from "./feature-flag.service";
import { CreateFeatureFlagRequest, DatabaseGetTableRequest, UpdateFeatureFlagRequest } from "./adminApiTypes";
import { ValidationPipeline } from "src/auth/ValidationPipeline";
import { isDev, AuthUser } from "src/util";
import { AuthService } from "src/auth/auth.service";
import { TieredStorageService } from "src/file-system/tiered-storage.service";
import { CronAdminService } from "./cron.service";
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
      private readonly config: ConfigService<EnvVariables>,
      private readonly featureFlagService: FeatureFlagService,
      private readonly authService: AuthService,
      private readonly tieredStorage: TieredStorageService,
      private readonly cronService: CronAdminService,
   ) { }

   @Get("cron")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public listCronJobs() {
      return this.cronService.list();
   }

   @Post("cron/:name/run")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public runCronJob(@Param("name") name: string) {
      return this.cronService.trigger(name);
   }

   @Get("tiered-storage")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public tieredStorageOverview() {
      return this.tieredStorage.getOverview();
   }

   @Post("tiered-storage/drives/:name/evacuate")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public evacuateColdDrive(@Param("name") name: string) {
      return this.tieredStorage.evacuateDrive(name);
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

   // Service-to-service read (e.g. shado-auth-api), authenticated via x-service-key.
   @Get("featureFlag/:namespace/:key/enabled")
   @UseGuards(ServiceKeyGuard)
   public async isFeatureFlagEnabledForService(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ): Promise<{ enabled: boolean }> {
      return { enabled: await this.featureFlagService.isFeatureFlagEnabled(namespace, key) };
   }

   /**
    * Service-to-service read that also returns the flag's payload, for flags whose payload
    * is configuration in its own right (e.g. shado-music-api's YouTube cookies).
    *
    * Kept separate from `/enabled` so the common "is it on?" check stays a plain boolean
    * and callers only receive payloads — which may hold credentials — when they ask.
    */
   @Get("featureFlag/:namespace/:key/payload")
   @UseGuards(ServiceKeyGuard)
   public async getFeatureFlagPayloadForService(
      @Param("namespace", new ParseEnumPipe(FeatureFlagNamespace)) namespace: FeatureFlagNamespace,
      @Param("key") key: string,
   ): Promise<{ enabled: boolean; payload: string | null }> {
      // getFeatureFlag() returns null the very first time it auto-creates a flag, so treat
      // a missing row as disabled with no payload.
      const flag = await this.featureFlagService.getFeatureFlag(namespace, key);
      return { enabled: flag?.enabled === true, payload: flag?.payload ?? null };
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
         void this.adminService.deleteBackupFile(filePath);
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
}
