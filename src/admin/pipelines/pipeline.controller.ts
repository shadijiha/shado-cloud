import {
   Body,
   Controller,
   Delete,
   Get,
   Headers,
   HttpCode,
   HttpException,
   HttpStatus,
   Logger,
   MessageEvent,
   Param,
   ParseIntPipe,
   Post,
   Put,
   Query,
   Sse,
   UnauthorizedException,
   UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Observable } from "rxjs";
import crypto from "crypto";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { AuthUser } from "src/util";
import { EnvVariables } from "src/config/config.validator";
import { AdminGuard } from "../admin.strategy";
import { PipelineService } from "./pipeline.service";
import {
   BlockerInput,
   PipelineConfigService,
   PipelineInput,
   PromotionInput,
   StageInput,
   TargetInput,
   WaveInput,
   WorkflowInput,
   WorkflowStepInput,
} from "./pipeline-config.service";
import { PromotionBlockerService } from "./promotion-blocker.service";
import { PIPELINE_TEMPLATES } from "./pipeline.blueprints";
import {
   extractBuiltCommit,
   GithubPushPayload,
   hasSkipDirective,
   shouldTrigger,
} from "./github-webhook.util";
import { PromotionState } from "src/models/admin/pipeline/pipeline.types";

/**
 * HTTP surface for the pipeline release system.
 *
 * Everything except the GitHub webhook requires an authenticated admin. The
 * webhook is authenticated by its HMAC signature instead, because GitHub cannot
 * present a session cookie.
 */
@Controller("admin/pipelines")
@ApiTags("Pipelines")
export class PipelineController {
   private readonly logger = new Logger(PipelineController.name);

   constructor(
      private readonly pipelines: PipelineService,
      private readonly config: PipelineConfigService,
      private readonly blockers: PromotionBlockerService,
      private readonly appConfig: ConfigService<EnvVariables>,
   ) {}

   /** Audit label for the acting admin. Local users carry no name, only an id. */
   private actor(userId: number): string {
      return userId && userId !== -1 ? `admin#${userId}` : "admin";
   }

   private wrap<T>(promise: Promise<T>): Promise<T> {
      return promise.catch((e: Error) => {
         if (e instanceof HttpException) throw e;
         throw new HttpException(e.message, HttpStatus.BAD_REQUEST);
      });
   }

   // ── discovery ────────────────────────────────────────────────────────────

   @Get("templates")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Blueprints available in the create-pipeline picker" })
   public listTemplates() {
      return Object.entries(PIPELINE_TEMPLATES).map(([id, blueprint]) => ({
         id,
         name: blueprint.name,
         description: blueprint.description ?? null,
         stages: blueprint.stages.length,
         waves: blueprint.waves?.length ?? 0,
      }));
   }

   @Get("replicas")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Replicas currently connected, and whether fan-out is possible here" })
   public listReplicas() {
      return {
         available: this.pipelines.replicaDeploymentsAvailable(),
         nodes: this.pipelines.describeReplicas(),
      };
   }

   @Get()
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "List every pipeline" })
   public async list() {
      const pipelines = await this.pipelines.listPipelines();
      return Promise.all(
         pipelines.map(async (pipeline) => {
            const open = await this.pipelines.getOpenRun(pipeline.slug);
            return {
               ...pipeline,
               isRunning: await this.pipelines.isRunning(pipeline.slug),
               openRun: open ? this.pipelines.serializeRunEntity(open) : null,
            };
         }),
      );
   }

   @Post()
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Create a pipeline, optionally from a template" })
   public async create(@Body() body: PipelineInput & { template?: string }) {
      if (body.template) {
         const blueprint = PIPELINE_TEMPLATES[body.template];
         if (!blueprint) throw new HttpException(`Unknown template "${body.template}"`, HttpStatus.BAD_REQUEST);
         const slug = body.slug ?? blueprint.slug;
         if (await this.pipelines.getPipeline(slug)) {
            throw new HttpException(`Pipeline "${slug}" already exists`, HttpStatus.BAD_REQUEST);
         }
         return this.wrap(
            this.pipelines.createFromBlueprint({
               ...blueprint,
               slug,
               name: body.name ?? blueprint.name,
               workDir: body.workDir ?? blueprint.workDir,
               branch: body.branch ?? blueprint.branch,
               pm2ProcessName: body.pm2ProcessName ?? blueprint.pm2ProcessName,
            }),
         );
      }
      return this.wrap(this.config.createPipeline(body));
   }

   @Get(":slug")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiParam({ name: "slug", description: "Pipeline slug" })
   @ApiOperation({ summary: "Full pipeline graph with live blocker state, current run and history" })
   public async get(@Param("slug") slug: string, @Query("history") history?: string) {
      const limit = Math.min(Math.max(Number(history) || 20, 1), 100);
      const view = await this.pipelines.getPipelineView(slug, limit);
      if (!view) throw new HttpException(`Pipeline "${slug}" not found`, HttpStatus.NOT_FOUND);
      return view;
   }

   @Put(":slug")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public update(@Param("slug") slug: string, @Body() body: PipelineInput) {
      return this.wrap(this.config.updatePipeline(slug, body));
   }

   @Delete(":slug")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async remove(@Param("slug") slug: string) {
      await this.wrap(this.config.deletePipeline(slug));
      return { success: true };
   }

   /** Andon cord — holds every automated promotion in the pipeline. */
   @Post(":slug/hold")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public setHold(
      @Param("slug") slug: string,
      @Body() body: { hold: boolean; message?: string },
      @AuthUser() userId: number,
   ) {
      return this.wrap(this.config.setPipelineHold(slug, !!body.hold, this.actor(userId), body.message));
   }

   // ── waves ────────────────────────────────────────────────────────────────

   @Post(":slug/waves")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createWave(@Param("slug") slug: string, @Body() body: WaveInput) {
      return this.wrap(this.config.createWave(slug, body));
   }

   @Put(":slug/waves/:waveId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updateWave(
      @Param("slug") slug: string,
      @Param("waveId", ParseIntPipe) waveId: number,
      @Body() body: WaveInput,
   ) {
      return this.wrap(this.config.updateWave(slug, waveId, body));
   }

   @Delete(":slug/waves/:waveId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteWave(@Param("slug") slug: string, @Param("waveId", ParseIntPipe) waveId: number) {
      await this.wrap(this.config.deleteWave(slug, waveId));
      return { success: true };
   }

   // ── stages ───────────────────────────────────────────────────────────────
   // NOTE: `stages/reorder` must be declared before `stages/:stageId`, otherwise
   // "reorder" is captured as a stage id.

   @Post(":slug/stages/reorder")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Apply a new left-to-right stage order" })
   public reorderStages(@Param("slug") slug: string, @Body() body: { stageIds: number[] }) {
      return this.wrap(this.config.reorderStages(slug, body.stageIds ?? []));
   }

   @Post(":slug/stages")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createStage(@Param("slug") slug: string, @Body() body: StageInput) {
      return this.wrap(this.config.createStage(slug, body));
   }

   @Put(":slug/stages/:stageId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updateStage(
      @Param("slug") slug: string,
      @Param("stageId", ParseIntPipe) stageId: number,
      @Body() body: StageInput,
   ) {
      return this.wrap(this.config.updateStage(slug, stageId, body));
   }

   @Delete(":slug/stages/:stageId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteStage(@Param("slug") slug: string, @Param("stageId", ParseIntPipe) stageId: number) {
      await this.wrap(this.config.deleteStage(slug, stageId));
      return { success: true };
   }

   // ── targets ──────────────────────────────────────────────────────────────

   @Post(":slug/stages/:stageId/targets")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createTarget(
      @Param("slug") slug: string,
      @Param("stageId", ParseIntPipe) stageId: number,
      @Body() body: TargetInput,
   ) {
      return this.wrap(this.config.createTarget(slug, stageId, body));
   }

   @Put(":slug/targets/:targetId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updateTarget(
      @Param("slug") slug: string,
      @Param("targetId", ParseIntPipe) targetId: number,
      @Body() body: TargetInput,
   ) {
      return this.wrap(this.config.updateTarget(slug, targetId, body));
   }

   @Delete(":slug/targets/:targetId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteTarget(@Param("slug") slug: string, @Param("targetId", ParseIntPipe) targetId: number) {
      await this.wrap(this.config.deleteTarget(slug, targetId));
      return { success: true };
   }

   // ── promotions ───────────────────────────────────────────────────────────

   @Post(":slug/promotions")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createPromotion(@Param("slug") slug: string, @Body() body: PromotionInput) {
      return this.wrap(this.config.createPromotion(slug, body));
   }

   @Put(":slug/promotions/:promotionId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updatePromotion(
      @Param("slug") slug: string,
      @Param("promotionId", ParseIntPipe) promotionId: number,
      @Body() body: PromotionInput,
   ) {
      return this.wrap(this.config.updatePromotion(slug, promotionId, body));
   }

   @Delete(":slug/promotions/:promotionId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deletePromotion(
      @Param("slug") slug: string,
      @Param("promotionId", ParseIntPipe) promotionId: number,
   ) {
      await this.wrap(this.config.deletePromotion(slug, promotionId));
      return { success: true };
   }

   @Post(":slug/promotions/:promotionId/state")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Turn promotion automation ON / OFF / DISABLED" })
   public setPromotionState(
      @Param("slug") slug: string,
      @Param("promotionId", ParseIntPipe) promotionId: number,
      @Body() body: { state: PromotionState; message?: string },
      @AuthUser() userId: number,
   ) {
      if (!Object.values(PromotionState).includes(body.state)) {
         throw new HttpException(
            `state must be one of ${Object.values(PromotionState).join(", ")}`,
            HttpStatus.BAD_REQUEST,
         );
      }
      return this.wrap(this.config.setPromotionState(slug, promotionId, body.state, this.actor(userId), body.message));
   }

   @Post(":slug/promotions/:promotionId/bypass")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Arm a one-shot bypass of this promotion's blockers" })
   public armBypass(
      @Param("slug") slug: string,
      @Param("promotionId", ParseIntPipe) promotionId: number,
      @AuthUser() userId: number,
   ) {
      return this.wrap(this.config.armBypass(slug, promotionId, this.actor(userId)));
   }

   @Delete(":slug/promotions/:promotionId/bypass")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public clearBypass(@Param("slug") slug: string, @Param("promotionId", ParseIntPipe) promotionId: number) {
      return this.wrap(this.config.clearBypass(slug, promotionId));
   }

   // ── blockers ─────────────────────────────────────────────────────────────

   @Post(":slug/promotions/:promotionId/blockers")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createBlocker(
      @Param("slug") slug: string,
      @Param("promotionId", ParseIntPipe) promotionId: number,
      @Body() body: BlockerInput,
   ) {
      return this.wrap(this.config.createBlocker(slug, promotionId, body));
   }

   @Put(":slug/blockers/:blockerId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updateBlocker(
      @Param("slug") slug: string,
      @Param("blockerId", ParseIntPipe) blockerId: number,
      @Body() body: BlockerInput,
   ) {
      return this.wrap(this.config.updateBlocker(slug, blockerId, body));
   }

   @Delete(":slug/blockers/:blockerId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteBlocker(@Param("slug") slug: string, @Param("blockerId", ParseIntPipe) blockerId: number) {
      await this.wrap(this.config.deleteBlocker(slug, blockerId));
      return { success: true };
   }

   @Post(":slug/blockers/:blockerId/release")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Release a manual approval gate or environment lock" })
   public async releaseBlocker(
      @Param("slug") _slug: string,
      @Param("blockerId", ParseIntPipe) blockerId: number,
      @AuthUser() userId: number,
   ) {
      return this.wrap(this.blockers.release(blockerId, this.actor(userId)));
   }

   // ── approval workflows ───────────────────────────────────────────────────

   @Put(":slug/stages/:stageId/workflow")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Create or update the stage's approval workflow" })
   public upsertWorkflow(
      @Param("slug") slug: string,
      @Param("stageId", ParseIntPipe) stageId: number,
      @Body() body: WorkflowInput,
   ) {
      return this.wrap(this.config.upsertWorkflow(slug, stageId, body));
   }

   @Delete(":slug/stages/:stageId/workflow")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteWorkflow(@Param("slug") slug: string, @Param("stageId", ParseIntPipe) stageId: number) {
      await this.wrap(this.config.deleteWorkflow(slug, stageId));
      return { success: true };
   }

   @Post(":slug/stages/:stageId/workflow/steps")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public createWorkflowStep(
      @Param("slug") slug: string,
      @Param("stageId", ParseIntPipe) stageId: number,
      @Body() body: WorkflowStepInput,
   ) {
      return this.wrap(this.config.createWorkflowStep(slug, stageId, body));
   }

   @Put(":slug/workflow-steps/:stepId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public updateWorkflowStep(
      @Param("slug") slug: string,
      @Param("stepId", ParseIntPipe) stepId: number,
      @Body() body: WorkflowStepInput,
   ) {
      return this.wrap(this.config.updateWorkflowStep(slug, stepId, body));
   }

   @Delete(":slug/workflow-steps/:stepId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async deleteWorkflowStep(@Param("slug") slug: string, @Param("stepId", ParseIntPipe) stepId: number) {
      await this.wrap(this.config.deleteWorkflowStep(slug, stepId));
      return { success: true };
   }

   // ── runs ─────────────────────────────────────────────────────────────────

   @Get(":slug/runs")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async listRuns(@Param("slug") slug: string, @Query("limit") limit?: string) {
      const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const runs = await this.pipelines.getRunHistory(slug, take);
      return runs.map((run) => this.pipelines.serializeRunEntity(run));
   }

   @Get(":slug/runs/:runId")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async getRun(@Param("slug") slug: string, @Param("runId") runId: string) {
      const run = await this.pipelines.getRun(runId);
      if (!run || run.pipelineSlug !== slug) {
         throw new HttpException(`Run "${runId}" not found in "${slug}"`, HttpStatus.NOT_FOUND);
      }
      return this.pipelines.serializeRunEntity(run);
   }

   /** Starts a run and returns its live event stream in one request. */
   @Get(":slug/start")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @Sse()
   public async start(@Param("slug") slug: string, @AuthUser() userId: number): Promise<Observable<MessageEvent>> {
      const subject = await this.wrap(this.pipelines.startRun(slug, this.actor(userId)));
      return subject.asObservable();
   }

   /** Attaches to the stream of a run that is already in flight. */
   @Get(":slug/stream")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @Sse()
   public stream(@Param("slug") slug: string): Observable<MessageEvent> {
      const subject = this.pipelines.getSubject(slug);
      if (!subject) throw new HttpException("No run in progress", HttpStatus.NOT_FOUND);
      return subject.asObservable();
   }

   @Post(":slug/cancel")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async cancel(@Param("slug") slug: string, @AuthUser() userId: number) {
      await this.wrap(this.pipelines.cancelRun(slug, this.actor(userId)));
      return { success: true };
   }

   /**
    * Continues a paused run. `overrideStageIds` forces entry into stages whose
    * incoming promotion is OFF/DISABLED or still blocked.
    */
   @Get(":slug/resume")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @Sse()
   public async resume(
      @Param("slug") slug: string,
      @Query("overrideStageIds") overrideStageIds: string | undefined,
      @AuthUser() userId: number,
   ): Promise<Observable<MessageEvent>> {
      const overrides = (overrideStageIds ?? "")
         .split(",")
         .map((value) => Number(value.trim()))
         .filter((value) => Number.isFinite(value) && value > 0);
      const subject = await this.wrap(
         this.pipelines.resumeRun(slug, { triggeredBy: this.actor(userId), overrideStageIds: overrides }),
      );
      return subject.asObservable();
   }

   @Post(":slug/approve")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @ApiOperation({ summary: "Grant a pending approval and resume the run" })
   public approve(
      @Param("slug") slug: string,
      @Body() body: { stageId: number; step?: string },
      @AuthUser() userId: number,
   ) {
      if (!body?.stageId) throw new HttpException("stageId is required", HttpStatus.BAD_REQUEST);
      return this.wrap(this.pipelines.approve(slug, Number(body.stageId), this.actor(userId), body.step));
   }

   @Post(":slug/reject")
   @UseGuards(JwtAuthGuard, AdminGuard)
   public async reject(
      @Param("slug") slug: string,
      @Body() body: { stageId: number; reason?: string },
      @AuthUser() userId: number,
   ) {
      if (!body?.stageId) throw new HttpException("stageId is required", HttpStatus.BAD_REQUEST);
      await this.wrap(this.pipelines.reject(slug, Number(body.stageId), this.actor(userId), body.reason));
      return { success: true };
   }

   @Get(":slug/stages/:stageId/retry")
   @UseGuards(JwtAuthGuard, AdminGuard)
   @Sse()
   @ApiOperation({ summary: "Re-run a stage and everything downstream of it" })
   public async retryStage(
      @Param("slug") slug: string,
      @Param("stageId", ParseIntPipe) stageId: number,
      @AuthUser() userId: number,
   ): Promise<Observable<MessageEvent>> {
      const subject = await this.wrap(this.pipelines.reopenLastRun(slug, stageId, this.actor(userId)));
      return subject.asObservable();
   }

   // ── webhook ──────────────────────────────────────────────────────────────

   /**
    * GitHub push webhook. Unauthenticated by session — the HMAC signature is the
    * credential, so it is verified before anything else happens.
    *
    * Handles both branch pushes and tag pushes. Release automation commonly
    * pushes an annotated tag (`refs/tags/v3.0.90`) rather than committing to the
    * branch, so a branch-only rule would silently never fire.
    */
   @Post("webhook/:slug")
   @HttpCode(HttpStatus.OK)
   @ApiParam({ name: "slug", description: "Pipeline slug to trigger" })
   public async webhook(
      @Param("slug") slug: string,
      @Body() payload: GithubPushPayload,
      @Headers("x-hub-signature-256") signature: string,
   ) {
      const secret = this.appConfig.get("this-service.deployment.github-webhook-secret", { infer: true });
      if (!secret) {
         this.logger.error("Webhook rejected: github-webhook-secret is not configured");
         throw new HttpException("Webhook not configured", HttpStatus.SERVICE_UNAVAILABLE);
      }

      // Verify the signature first: everything below leaks information about the
      // pipeline (branch names, existence) and must not be reachable unsigned.
      const digest = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
      const expected = Buffer.from(`sha256=${digest}`);
      const received = Buffer.from(signature ?? "");
      if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
         this.logger.warn(`Webhook for "${slug}" rejected: invalid signature`);
         throw new UnauthorizedException("Invalid signature");
      }

      const pipeline = await this.pipelines.getPipeline(slug);
      if (!pipeline) throw new HttpException(`Pipeline "${slug}" not found`, HttpStatus.NOT_FOUND);
      if (!pipeline.enabled) return { triggered: false, message: `Pipeline "${slug}" is disabled` };

      const decision = shouldTrigger(payload, {
         branch: pipeline.branch,
         triggerOnTags: pipeline.triggerOnTags,
         tagPattern: pipeline.tagPattern,
      });
      if (!decision.trigger) {
         this.logger.log(`Webhook for "${slug}" ignored: ${decision.reason}`);
         return { triggered: false, message: decision.reason };
      }

      const commit = extractBuiltCommit(payload);

      if (hasSkipDirective(commit.message)) {
         return { triggered: false, message: "Skipped: commit contains [skip deploy]" };
      }

      if (await this.pipelines.isRunning(slug)) {
         await this.pipelines.enqueue(slug, "github-webhook", commit);
         return {
            triggered: false,
            queued: true,
            message: "Run queued",
            commit: { sha: commit.shortSha, ref: commit.refName },
         };
      }

      try {
         await this.pipelines.startRun(slug, "github-webhook", { commit });
         this.logger.log(
            `Webhook started a run for "${slug}" — ${decision.reason}, commit ${commit.shortSha ?? "(unknown)"}`,
         );
         return {
            triggered: true,
            message: `Run started (${decision.reason})`,
            commit: { sha: commit.shortSha, ref: commit.refName, message: commit.message },
         };
      } catch (e) {
         this.logger.error(`Webhook could not start a run for "${slug}": ${(e as Error).message}`);
         return { triggered: false, message: (e as Error).message };
      }
   }
}
