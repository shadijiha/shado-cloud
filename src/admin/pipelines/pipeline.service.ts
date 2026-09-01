import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Not, Repository } from "typeorm";
import { Subject } from "rxjs";
import type Redis from "ioredis";
import { EnvVariables } from "src/config/config.validator";
import { REDIS_CACHE } from "src/util";
import { EmailService } from "../email.service";
import { FeatureFlagService } from "../feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { Pipeline } from "src/models/admin/pipeline/pipeline";
import { PipelineWave } from "src/models/admin/pipeline/pipelineWave";
import { PipelineStage } from "src/models/admin/pipeline/pipelineStage";
import { PipelineTarget } from "src/models/admin/pipeline/pipelineTarget";
import { PipelinePromotion } from "src/models/admin/pipeline/pipelinePromotion";
import { PipelinePromotionBlocker } from "src/models/admin/pipeline/pipelinePromotionBlocker";
import { ApprovalWorkflow } from "src/models/admin/pipeline/approvalWorkflow";
import { ApprovalWorkflowStep } from "src/models/admin/pipeline/approvalWorkflowStep";
import { PipelineRun } from "src/models/admin/pipeline/pipelineRun";
import {
   BlockerKind,
   BlockerState,
   isTerminalRunStatus,
   PipelineEvent,
   PromotionState,
   ReplicaStepResult,
   RunStatus,
   StageKind,
   StageResult,
   StepResult,
   StepStatus,
   TargetKind,
} from "src/models/admin/pipeline/pipeline.types";
import {
   ReplicaDeploymentCoordinator,
   type ReplicaDeploymentSummary,
} from "src/replication/replica-deployment.coordinator";
import { StepRunnerService } from "./step-runner.service";
import { PromotionBlockerService } from "./promotion-blocker.service";
import { DEFAULT_PIPELINE_BLUEPRINTS, PipelineBlueprint, blueprintFromLegacyProject } from "./pipeline.blueprints";
import { DeploymentProject } from "src/models/admin/deploymentProject";
import { BuiltCommitInfo, buildRevisionLabel, shortenSha } from "./github-webhook.util";

/** Per-step output cap so a chatty build cannot exhaust memory. */
const MAX_STEP_OUTPUT = 256 * 1024;

const REDIS_QUEUE_PREFIX = "pipeline:queue:";

/** Statuses in which a run is paused and can be resumed by a human. */
const PAUSED_STATUSES: readonly RunStatus[] = [RunStatus.Blocked, RunStatus.AwaitingApproval];

/** In-memory view of a run while it executes. The DB holds the durable copy. */
interface LiveRun {
   run: PipelineRun;
   results: Record<string, StageResult>;
   /** Stages the operator explicitly forced through an OFF promotion. */
   overrides: Set<number>;
   cancelled: boolean;
}

type StageOutcome = "success" | "failed" | "restarting" | "skipped";
type WorkflowOutcome = "approved" | "failed" | "awaiting";

/** A pipeline plus its full graph, with everything sorted for rendering. */
export interface PipelineGraph {
   pipeline: Pipeline;
   waves: PipelineWave[];
   stages: PipelineStage[];
   promotions: PipelinePromotion[];
}

@Injectable()
export class PipelineService implements OnModuleInit {
   private readonly logger = new Logger(PipelineService.name);

   /** SSE subject per pipeline slug. */
   private readonly subjects = new Map<string, Subject<MessageEvent>>();
   /** Live run per pipeline slug. */
   private readonly liveRuns = new Map<string, LiveRun>();

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly emailService: EmailService,
      @Inject() private readonly featureFlagService: FeatureFlagService,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      private readonly runner: StepRunnerService,
      private readonly blockerService: PromotionBlockerService,
      @InjectRepository(Pipeline) private readonly pipelineRepo: Repository<Pipeline>,
      @InjectRepository(PipelineWave) private readonly waveRepo: Repository<PipelineWave>,
      @InjectRepository(PipelineStage) private readonly stageRepo: Repository<PipelineStage>,
      @InjectRepository(PipelineTarget) private readonly targetRepo: Repository<PipelineTarget>,
      @InjectRepository(PipelinePromotion) private readonly promotionRepo: Repository<PipelinePromotion>,
      @InjectRepository(PipelinePromotionBlocker) private readonly blockerRepo: Repository<PipelinePromotionBlocker>,
      @InjectRepository(ApprovalWorkflow) private readonly workflowRepo: Repository<ApprovalWorkflow>,
      @InjectRepository(ApprovalWorkflowStep) private readonly workflowStepRepo: Repository<ApprovalWorkflowStep>,
      @InjectRepository(PipelineRun) private readonly runRepo: Repository<PipelineRun>,
      @InjectRepository(DeploymentProject) private readonly legacyProjectRepo: Repository<DeploymentProject>,
      // Only provided on a master boot (it lives in the global module alongside the
      // replica-link registry), so it is optional exactly like FilesService's use of
      // the registry. A REPLICA target on a non-master node fails with a clear reason.
      @Optional() private readonly replicaDeployments?: ReplicaDeploymentCoordinator,
   ) {}

   // ────────────────────────────────────────────────────────────────────────
   // Lifecycle
   // ────────────────────────────────────────────────────────────────────────

   async onModuleInit() {
      try {
         await this.seedDefaults();
      } catch (e) {
         this.logger.error(`Failed to seed default pipelines: ${(e as Error).message}`);
      }
      try {
         await this.resumeInterruptedRuns();
      } catch (e) {
         this.logger.error(`Failed to resume interrupted runs: ${(e as Error).message}`);
      }
   }

   /**
    * Creates the built-in pipelines the first time the service boots. Existing
    * installations keep whatever they have — seeding only ever inserts.
    */
   private async seedDefaults() {
      for (const blueprint of DEFAULT_PIPELINE_BLUEPRINTS) {
         const existing = await this.pipelineRepo.findOneBy({ slug: blueprint.slug });
         if (existing) continue;

         // Prefer the operator's real configuration when a legacy flat deployment
         // project exists for this slug, so an upgrade shows their actual pipeline
         // rather than the generic template.
         const legacy = await this.legacyProjectRepo.findOneBy({ slug: blueprint.slug }).catch(() => null);
         if (legacy) {
            let steps: { step: string; name: string; cmd: string; args: string[]; triggersRestart?: boolean; skip?: boolean }[] = [];
            try {
               steps = legacy.getSteps();
            } catch {
               steps = [];
            }
            if (steps.length > 0) {
               await this.createFromBlueprint(
                  blueprintFromLegacyProject({
                     slug: legacy.slug,
                     name: legacy.name,
                     workDir: legacy.workDir,
                     branch: legacy.branch,
                     pm2ProcessName: legacy.pm2ProcessName,
                     steps,
                  }),
               );
               this.logger.log(`Imported legacy deployment project "${legacy.slug}" as a pipeline`);
               continue;
            }
         }

         await this.createFromBlueprint(blueprint);
         this.logger.log(`Seeded pipeline "${blueprint.slug}"`);
      }
   }

   /**
    * A run left in RUNNING state means the process died mid-run — almost always
    * because a target restarted us on purpose. Pick up from the stage we recorded.
    */
   private async resumeInterruptedRuns() {
      const running = await this.runRepo.find({ where: { status: RunStatus.Running } });
      for (const run of running) {
         if (!run.currentStageId) {
            await this.finalizeOrphan(run);
            continue;
         }
         this.logger.log(`Resuming run ${run.runId} of "${run.pipelineSlug}" from stage ${run.currentStageId}`);
         const live: LiveRun = {
            run,
            results: run.getStageResults(),
            overrides: new Set<number>(),
            cancelled: false,
         };
         this.liveRuns.set(run.pipelineSlug, live);
         this.subjects.set(run.pipelineSlug, new Subject<MessageEvent>());
         void this.execute(run.pipelineSlug, run.currentStageId);
      }
   }

   private async finalizeOrphan(run: PipelineRun) {
      run.status = RunStatus.Failed;
      run.error = "Run was interrupted and could not be resumed (no current stage recorded)";
      run.finishedAt = new Date();
      await this.runRepo.save(run);
   }

   // ────────────────────────────────────────────────────────────────────────
   // Graph loading
   // ────────────────────────────────────────────────────────────────────────

   /** Loads a pipeline with every relation needed to render it, fully sorted. */
   public async loadGraph(slug: string): Promise<PipelineGraph | null> {
      const pipeline = await this.pipelineRepo.findOneBy({ slug });
      if (!pipeline) return null;

      const [waves, stages, promotions] = await Promise.all([
         this.waveRepo.find({ where: { pipelineId: pipeline.id }, order: { position: "ASC", id: "ASC" } }),
         this.stageRepo.find({
            where: { pipelineId: pipeline.id },
            relations: { targets: true, approvalWorkflow: { steps: true } },
            order: { position: "ASC", id: "ASC" },
         }),
         this.promotionRepo.find({
            where: { pipelineId: pipeline.id },
            relations: { blockers: true },
            order: { id: "ASC" },
         }),
      ]);

      for (const stage of stages) {
         stage.targets = (stage.targets ?? []).sort((a, b) => a.position - b.position || a.id - b.id);
         if (stage.approvalWorkflow?.steps) {
            stage.approvalWorkflow.steps = stage.approvalWorkflow.steps.sort(
               (a, b) => a.position - b.position || a.id - b.id,
            );
         }
      }
      for (const promotion of promotions) {
         promotion.blockers = (promotion.blockers ?? []).sort((a, b) => a.id - b.id);
      }

      return { pipeline, waves, stages, promotions };
   }

   public async listPipelines(): Promise<Pipeline[]> {
      return this.pipelineRepo.find({ order: { id: "ASC" } });
   }

   /** True when this node can fan a deployment out to replicas (master boots only). */
   public replicaDeploymentsAvailable(): boolean {
      return !!this.replicaDeployments;
   }

   public describeReplicas(): { ip: string; deviceName: string; mirrorDirs: number }[] {
      return this.replicaDeployments?.describeConnected() ?? [];
   }

   public async getPipeline(slug: string): Promise<Pipeline | null> {
      return this.pipelineRepo.findOneBy({ slug });
   }

   /**
    * The payload the UI renders: graph + live blocker evaluation + the current
    * run and recent history.
    */
   public async getPipelineView(slug: string, historyLimit = 20) {
      const graph = await this.loadGraph(slug);
      if (!graph) return null;

      const promotions = await Promise.all(
         graph.promotions.map(async (promotion) => {
            const evaluation = await this.blockerService.evaluate(promotion.blockers);
            return {
               ...promotion,
               blockers: promotion.blockers.map((blocker) => ({
                  ...blocker,
                  config: blocker.getConfig(),
                  evaluation: evaluation.evaluations.find((e) => e.blockerId === blocker.id) ?? null,
               })),
               evaluation,
            };
         }),
      );

      const live = this.liveRuns.get(slug);
      const currentRun = live ? this.serializeRun(live) : await this.getOpenRun(slug).then((r) => (r ? this.serializeRunEntity(r) : null));

      const [history, lastRun] = await Promise.all([
         this.runRepo.find({
            where: { pipelineId: graph.pipeline.id },
            order: { sequence: "DESC" },
            take: historyLimit,
            select: [
               "id", "runId", "sequence", "revision", "status", "triggeredBy",
               "startedAt", "finishedAt", "durationMs", "error", "blockedReason", "commitMessage",
               "commitSha", "commitUrl", "commitAuthor", "commitAuthorUsername", "commitTimestamp",
               "gitRef", "gitRefName", "gitRefType", "repositoryName", "compareUrl", "pushedBy",
            ],
         }),
         this.runRepo.findOne({
            where: { pipelineId: graph.pipeline.id, status: In([RunStatus.Succeeded, RunStatus.Failed]) },
            order: { sequence: "DESC" },
         }),
      ]);

      return {
         pipeline: graph.pipeline,
         waves: graph.waves,
         stages: graph.stages.map((stage) => ({
            ...stage,
            targets: stage.targets.map((target) => ({ ...target, args: target.getArgs() })),
            approvalWorkflow: stage.approvalWorkflow
               ? {
                    ...stage.approvalWorkflow,
                    steps: stage.approvalWorkflow.steps.map((step) => ({
                       ...step,
                       args: step.getArgs(),
                       dependencies: step.getDependencies(),
                    })),
                 }
               : null,
         })),
         promotions,
         currentRun,
         lastRun: lastRun ? this.serializeRunEntity(lastRun) : null,
         history: history.map((run) => ({
            id: run.id,
            runId: run.runId,
            sequence: run.sequence,
            revision: run.revision,
            status: run.status,
            triggeredBy: run.triggeredBy,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            durationMs: run.durationMs,
            error: run.error,
            blockedReason: run.blockedReason,
            commitMessage: run.commitMessage,
            commit: this.serializeCommit(run),
         })),
         isRunning: !!live && !isTerminalRunStatus(live.run.status),
         fitness: this.computeFitness(graph, promotions),
         queue: await this.getQueue(slug),
         // Surfaced so the editor can show what a replica fan-out would reach, and
         // whether this node can do one at all.
         replicas: {
            available: !!this.replicaDeployments,
            connected: this.replicaDeployments?.connectedCount() ?? 0,
            nodes: this.replicaDeployments?.describeConnected() ?? [],
         },
      };
   }

   /**
    * Health counters mirroring the "why isn't my change progressing?" checks:
    * disabled promotions, promotions requiring approval with no workflow behind
    * them, and stages with no targets.
    */
   private computeFitness(graph: PipelineGraph, promotions: { state: PromotionState; requiresApproval: boolean; sourceStageId: number | null; evaluation: { isBlocked: boolean } }[]) {
      const stageById = new Map(graph.stages.map((s) => [s.id, s]));
      let requiredApprovalsWithoutWorkflows = 0;
      for (const promotion of promotions) {
         if (!promotion.requiresApproval) continue;
         const source = promotion.sourceStageId ? stageById.get(promotion.sourceStageId) : null;
         if (!source?.approvalWorkflow?.enabled) requiredApprovalsWithoutWorkflows++;
      }
      return {
         stages: graph.stages.length,
         waves: graph.waves.length,
         promotions: promotions.length,
         disabledPromotions: promotions.filter((p) => p.state === PromotionState.Disabled).length,
         nonAutomatedPromotions: promotions.filter((p) => p.state === PromotionState.Off).length,
         blockedPromotions: promotions.filter((p) => p.evaluation.isBlocked).length,
         stagesWithoutTargets: graph.stages.filter((s) => (s.targets ?? []).length === 0).length,
         manualApprovalSteps: graph.stages.reduce(
            (acc, s) => acc + (s.approvalWorkflow?.steps ?? []).filter((step) => step.manual).length,
            0,
         ),
         requiredApprovalsWithoutWorkflows,
         pipelineDisabled: graph.pipeline.disabled,
      };
   }

   // ────────────────────────────────────────────────────────────────────────
   // Blueprint / pipeline creation
   // ────────────────────────────────────────────────────────────────────────

   /**
    * Materialises a declarative blueprint into rows. Used for seeding and for the
    * "create pipeline from template" action in the UI.
    */
   public async createFromBlueprint(blueprint: PipelineBlueprint): Promise<Pipeline> {
      const pipeline = await this.pipelineRepo.save(
         this.pipelineRepo.create({
            slug: blueprint.slug,
            name: blueprint.name,
            description: blueprint.description ?? null,
            workDir: blueprint.workDir ?? "",
            branch: blueprint.branch ?? "master",
            pm2ProcessName: blueprint.pm2ProcessName ?? null,
            owner: blueprint.owner ?? null,
            enabled: true,
            disabled: false,
         }),
      );

      const waveBySlug = new Map<string, PipelineWave>();
      for (const [index, wave] of (blueprint.waves ?? []).entries()) {
         const saved = await this.waveRepo.save(
            this.waveRepo.create({
               pipelineId: pipeline.id,
               name: wave.name,
               kind: wave.kind,
               position: wave.position ?? index,
               bakeTimeMinutes: wave.bakeTimeMinutes ?? 0,
               staggerMinutes: wave.staggerMinutes ?? 0,
               accentColor: wave.accentColor ?? "#5f6b7a",
            }),
         );
         waveBySlug.set(wave.key, saved);
      }

      const stageByKey = new Map<string, PipelineStage>();
      for (const [index, stage] of blueprint.stages.entries()) {
         const saved = await this.stageRepo.save(
            this.stageRepo.create({
               pipelineId: pipeline.id,
               waveId: stage.wave ? (waveBySlug.get(stage.wave)?.id ?? null) : null,
               name: stage.name,
               kind: stage.kind,
               position: stage.position ?? index,
               isProd: stage.isProd ?? false,
               description: stage.description ?? null,
               enabled: true,
            }),
         );
         stageByKey.set(stage.key, saved);

         for (const [targetIndex, target] of stage.targets.entries()) {
            await this.targetRepo.save(
               this.targetRepo.create({
                  stageId: saved.id,
                  name: target.name,
                  kind: target.kind,
                  position: targetIndex,
                  cmd: target.cmd ?? "",
                  args: JSON.stringify(target.args ?? []),
                  workDir: target.workDir ?? "",
                  url: target.url ?? null,
                  triggersRestart: target.triggersRestart ?? false,
                  skip: false,
                  maxAttempts: target.maxAttempts ?? 3,
                  timeoutMs: target.timeoutMs ?? 0,
               }),
            );
         }

         if (stage.approvalWorkflow) {
            const workflow = await this.workflowRepo.save(
               this.workflowRepo.create({
                  stageId: saved.id,
                  name: stage.approvalWorkflow.name,
                  rollbackOnFailure: stage.approvalWorkflow.rollbackOnFailure ?? false,
                  requiresConsistentRevisions: stage.approvalWorkflow.requiresConsistentRevisions ?? false,
                  enabled: true,
               }),
            );
            for (const [stepIndex, step] of stage.approvalWorkflow.steps.entries()) {
               await this.workflowStepRepo.save(
                  this.workflowStepRepo.create({
                     workflowId: workflow.id,
                     name: step.name,
                     position: stepIndex,
                     manual: step.manual ?? false,
                     cmd: step.cmd ?? "",
                     args: JSON.stringify(step.args ?? []),
                     workDir: step.workDir ?? "",
                     dependencies: JSON.stringify(step.dependencies ?? []),
                     maxAttempts: step.maxAttempts ?? 1,
                     timeoutMs: step.timeoutMs ?? 0,
                     enabled: true,
                  }),
               );
            }
         }
      }

      for (const promotion of blueprint.promotions ?? []) {
         const dest = stageByKey.get(promotion.to);
         if (!dest) continue;
         const source = promotion.from ? stageByKey.get(promotion.from) : null;
         const saved = await this.promotionRepo.save(
            this.promotionRepo.create({
               pipelineId: pipeline.id,
               sourceStageId: source?.id ?? null,
               destStageId: dest.id,
               kind: promotion.kind,
               state: promotion.state ?? PromotionState.On,
               requiresApproval: promotion.requiresApproval ?? false,
               approvalName: promotion.approvalName ?? null,
            }),
         );
         for (const blocker of promotion.blockers ?? []) {
            await this.blockerRepo.save(
               this.blockerRepo.create({
                  promotionId: saved.id,
                  kind: blocker.kind,
                  name: blocker.name,
                  description: blocker.description ?? null,
                  config: JSON.stringify(blocker.config ?? {}),
                  // Manual gates and locks start armed so the first run stops at them.
                  state:
                     blocker.kind === BlockerKind.ManualApproval || blocker.kind === BlockerKind.Lock
                        ? BlockerState.Blocking
                        : BlockerState.Ok,
                  enabled: true,
               }),
            );
         }
      }

      return pipeline;
   }

   // ────────────────────────────────────────────────────────────────────────
   // Run bookkeeping
   // ────────────────────────────────────────────────────────────────────────

   /** The single non-terminal run for a pipeline, if one exists. */
   public async getOpenRun(slug: string): Promise<PipelineRun | null> {
      return this.runRepo.findOne({
         where: { pipelineSlug: slug, status: Not(In([RunStatus.Succeeded, RunStatus.Failed, RunStatus.Cancelled])) },
         order: { sequence: "DESC" },
      });
   }

   public async isRunning(slug: string): Promise<boolean> {
      const live = this.liveRuns.get(slug);
      if (live && !isTerminalRunStatus(live.run.status) && !PAUSED_STATUSES.includes(live.run.status)) return true;
      const open = await this.getOpenRun(slug);
      return !!open && !PAUSED_STATUSES.includes(open.status);
   }

   public getSubject(slug: string): Subject<MessageEvent> | null {
      return this.subjects.get(slug) ?? null;
   }

   public async getRun(runId: string): Promise<PipelineRun | null> {
      return this.runRepo.findOneBy({ runId });
   }

   public async getRunHistory(slug: string, limit = 50): Promise<PipelineRun[]> {
      return this.runRepo.find({ where: { pipelineSlug: slug }, order: { sequence: "DESC" }, take: limit });
   }

   public async enqueue(slug: string, triggeredBy: string, commit?: BuiltCommitInfo | null): Promise<void> {
      await this.redis.rpush(REDIS_QUEUE_PREFIX + slug, JSON.stringify({ triggeredBy, commit: commit ?? null }));
      this.logger.log(`Queued run for "${slug}" (triggered by ${triggeredBy})`);
   }

   public async getQueue(slug: string): Promise<{ triggeredBy: string; commitMessage?: string; revision?: string }[]> {
      const items = await this.redis.lrange(REDIS_QUEUE_PREFIX + slug, 0, -1);
      return items.map((item) => {
         try {
            const parsed = JSON.parse(item);
            return {
               triggeredBy: parsed.triggeredBy ?? "unknown",
               commitMessage: parsed.commit?.message ?? parsed.commitMessage ?? undefined,
               revision: parsed.commit?.refName ?? parsed.commit?.shortSha ?? undefined,
            };
         } catch {
            return { triggeredBy: "unknown" };
         }
      });
   }

   private async processQueue(slug: string): Promise<void> {
      const next = await this.redis.lpop(REDIS_QUEUE_PREFIX + slug);
      if (!next) return;
      try {
         const { triggeredBy, commit } = JSON.parse(next);
         // Re-hydrate the Date that JSON.stringify flattened to a string.
         const rehydrated: BuiltCommitInfo | undefined = commit
            ? { ...commit, committedAt: commit.committedAt ? new Date(commit.committedAt) : null }
            : undefined;
         await this.startRun(slug, triggeredBy ?? "queue", { commit: rehydrated });
      } catch (e) {
         this.logger.error(`Failed to start queued run for "${slug}": ${(e as Error).message}`);
      }
   }

   // ────────────────────────────────────────────────────────────────────────
   // Starting / resuming / cancelling runs
   // ────────────────────────────────────────────────────────────────────────

   public async startRun(
      slug: string,
      triggeredBy: string,
      opts: { revision?: string; commitMessage?: string; commit?: BuiltCommitInfo } = {},
   ): Promise<Subject<MessageEvent>> {
      const graph = await this.loadGraph(slug);
      if (!graph) throw new Error(`Pipeline "${slug}" not found`);
      if (!graph.pipeline.enabled) throw new Error(`Pipeline "${slug}" is disabled`);
      if (graph.pipeline.disabled) {
         throw new Error(
            `Pipeline "${slug}" is held${graph.pipeline.disabledBy ? ` by ${graph.pipeline.disabledBy}` : ""}` +
               `${graph.pipeline.disabledMessage ? `: ${graph.pipeline.disabledMessage}` : ""}`,
         );
      }
      if (graph.stages.length === 0) throw new Error(`Pipeline "${slug}" has no stages`);

      const open = await this.getOpenRun(slug);
      if (open) {
         throw new Error(
            PAUSED_STATUSES.includes(open.status)
               ? `Run ${open.runId} is paused (${open.status}) — resolve or cancel it before starting a new run`
               : `A run is already in progress for "${slug}"`,
         );
      }

      const last = await this.runRepo.findOne({ where: { pipelineId: graph.pipeline.id }, order: { sequence: "DESC" } });
      const now = new Date();
      const fallbackRevision = `${now.toISOString().slice(0, 10)}.${now.getTime() % 100000}`;

      // Webhook runs arrive with the pushed commit; manually started runs read it
      // out of the working copy, so every run records what was actually built.
      const commit = opts.commit ?? (await this.resolveLocalCommit(graph.pipeline));

      const run = await this.runRepo.save(
         this.runRepo.create({
            runId: `run_${now.getTime()}`,
            pipelineId: graph.pipeline.id,
            pipelineSlug: slug,
            sequence: (last?.sequence ?? 0) + 1,
            revision: opts.revision || (commit ? buildRevisionLabel(commit, fallbackRevision) : fallbackRevision),
            status: RunStatus.Running,
            triggeredBy,
            commitMessage: opts.commitMessage ?? commit?.message ?? null,
            commitSha: commit?.sha ?? null,
            commitUrl: commit?.url ?? null,
            commitAuthor: commit?.authorName ?? null,
            commitAuthorUsername: commit?.authorUsername ?? null,
            commitTimestamp: commit?.committedAt ?? null,
            gitRef: commit?.ref ?? null,
            gitRefName: commit?.refName ?? null,
            gitRefType: commit?.refType ?? null,
            repositoryName: commit?.repository ?? null,
            compareUrl: commit?.compareUrl ?? null,
            changedFiles: JSON.stringify(commit?.changedFiles ?? []),
            pushedBy: commit?.pushedBy ?? null,
            currentStageId: graph.stages[0].id,
            stageResults: "{}",
            startedAt: now,
         }),
      );

      const live: LiveRun = { run, results: {}, overrides: new Set<number>(), cancelled: false };
      this.liveRuns.set(slug, live);

      const subject = new Subject<MessageEvent>();
      this.subjects.set(slug, subject);

      void this.execute(slug, graph.stages[0].id, { notifyStart: true });
      return subject;
   }

   /**
    * Continues a paused run. `overrideStageIds` lets the operator push through a
    * promotion whose automation is OFF or whose blockers are still active.
    */
   public async resumeRun(
      slug: string,
      opts: { overrideStageIds?: number[]; triggeredBy: string } = { triggeredBy: "admin" },
   ): Promise<Subject<MessageEvent>> {
      const open = await this.getOpenRun(slug);
      if (!open) throw new Error(`No open run for "${slug}"`);
      if (!PAUSED_STATUSES.includes(open.status)) throw new Error(`Run ${open.runId} is not paused`);
      if (!open.currentStageId) throw new Error(`Run ${open.runId} has no stage to resume from`);

      const live: LiveRun = this.liveRuns.get(slug) ?? {
         run: open,
         results: open.getStageResults(),
         overrides: new Set<number>(),
         cancelled: false,
      };
      live.run = open;
      live.cancelled = false;
      for (const stageId of opts.overrideStageIds ?? []) live.overrides.add(stageId);
      this.liveRuns.set(slug, live);

      open.status = RunStatus.Running;
      open.blockedReason = null;
      await this.runRepo.save(open);

      const subject = new Subject<MessageEvent>();
      this.subjects.set(slug, subject);

      this.logger.log(`Run ${open.runId} resumed by ${opts.triggeredBy}`);
      void this.execute(slug, open.currentStageId);
      return subject;
   }

   /**
    * Grants a pending approval.
    *
    * With `step` it approves a manual approval-workflow step; without it, it
    * releases every manual gate blocking the promotion into `stageId`. Either way
    * the run is resumed.
    */
   public async approve(
      slug: string,
      stageId: number,
      approvedBy: string,
      step?: string,
   ): Promise<{ resumed: boolean }> {
      const open = await this.getOpenRun(slug);
      if (!open) throw new Error(`No open run for "${slug}"`);

      const results = this.liveRuns.get(slug)?.results ?? open.getStageResults();
      const stageResult = results[String(stageId)];

      if (step) {
         const workflowStep = stageResult?.workflow?.steps?.[step];
         if (!workflowStep) throw new Error(`Step "${step}" is not awaiting approval`);
         workflowStep.status = "success";
         workflowStep.finishedAt = new Date().toISOString();
         workflowStep.output += `\nApproved by ${approvedBy}\n`;
         if (stageResult.workflow) {
            stageResult.workflow.approvedBy = approvedBy;
            stageResult.workflow.approvedAt = new Date().toISOString();
         }
      } else {
         const promotion = await this.promotionRepo.findOne({
            where: { pipelineId: open.pipelineId, destStageId: stageId },
            relations: { blockers: true },
         });
         if (!promotion) throw new Error(`No promotion into stage ${stageId}`);
         const gates = (promotion.blockers ?? []).filter(
            (b) => b.enabled && b.state !== BlockerState.Ok && (b.kind === BlockerKind.ManualApproval || b.kind === BlockerKind.Lock),
         );
         if (gates.length === 0) throw new Error("Nothing is awaiting approval on this promotion");
         for (const gate of gates) await this.blockerService.release(gate.id, approvedBy);
      }

      const live = this.liveRuns.get(slug);
      if (live) {
         live.results = results;
      }
      open.setStageResults(results);
      await this.runRepo.save(open);

      await this.resumeRun(slug, { triggeredBy: approvedBy, overrideStageIds: [stageId] });
      return { resumed: true };
   }

   /** Rejects a pending approval, failing the run. */
   public async reject(slug: string, stageId: number, rejectedBy: string, reason?: string): Promise<void> {
      const open = await this.getOpenRun(slug);
      if (!open) throw new Error(`No open run for "${slug}"`);
      const live = this.liveRuns.get(slug);
      const results = live?.results ?? open.getStageResults();
      const stageResult = results[String(stageId)];
      if (stageResult) {
         stageResult.status = "failed";
         stageResult.error = `Rejected by ${rejectedBy}${reason ? `: ${reason}` : ""}`;
         stageResult.finishedAt = new Date().toISOString();
      }
      open.setStageResults(results);
      open.status = RunStatus.Failed;
      open.error = `Rejected by ${rejectedBy}${reason ? `: ${reason}` : ""}`;
      open.finishedAt = new Date();
      open.durationMs = open.startedAt ? open.finishedAt.getTime() - new Date(open.startedAt).getTime() : 0;
      await this.runRepo.save(open);
      this.emit(slug, { type: "run_complete", runId: open.runId, run: this.serializeRunEntity(open) });
      this.closeStream(slug);
      this.liveRuns.delete(slug);
   }

   public async cancelRun(slug: string, cancelledBy: string): Promise<void> {
      const open = await this.getOpenRun(slug);
      if (!open) throw new Error(`No open run for "${slug}"`);

      const live = this.liveRuns.get(slug);
      if (live) live.cancelled = true;
      this.runner.cancelAll(`${open.runId}:`);

      const results = live?.results ?? open.getStageResults();
      for (const result of Object.values(results)) {
         if (result.status === "running") {
            result.status = "failed";
            result.error = `Cancelled by ${cancelledBy}`;
            result.finishedAt = new Date().toISOString();
         }
         for (const target of Object.values(result.targets ?? {})) {
            if (target.status === "running") {
               target.status = "failed";
               target.error = `Cancelled by ${cancelledBy}`;
               target.finishedAt = new Date().toISOString();
            }
         }
      }

      open.setStageResults(results);
      open.status = RunStatus.Cancelled;
      open.error = `Cancelled by ${cancelledBy}`;
      open.finishedAt = new Date();
      open.durationMs = open.startedAt ? open.finishedAt.getTime() - new Date(open.startedAt).getTime() : 0;
      open.currentStageId = null;
      await this.runRepo.save(open);

      this.emit(slug, { type: "run_complete", runId: open.runId, run: this.serializeRunEntity(open) });
      this.closeStream(slug);
      this.liveRuns.delete(slug);
      this.logger.log(`Run ${open.runId} cancelled by ${cancelledBy}`);
   }

   /** Re-runs a failed stage and everything after it. */
   public async retryStage(slug: string, stageId: number, triggeredBy: string): Promise<Subject<MessageEvent>> {
      const open = await this.getOpenRun(slug);
      if (!open) throw new Error(`No run to retry for "${slug}"`);
      if (await this.isRunning(slug)) throw new Error("A run is already in progress");

      const results = open.getStageResults();
      // Drop the failed stage and everything downstream so they re-execute.
      const graph = await this.loadGraph(slug);
      if (!graph) throw new Error(`Pipeline "${slug}" not found`);
      const fromIndex = graph.stages.findIndex((s) => s.id === stageId);
      if (fromIndex === -1) throw new Error(`Stage ${stageId} is not part of "${slug}"`);
      for (const stage of graph.stages.slice(fromIndex)) delete results[String(stage.id)];

      open.setStageResults(results);
      open.status = RunStatus.Running;
      open.error = null;
      open.blockedReason = null;
      open.finishedAt = null;
      open.currentStageId = stageId;
      await this.runRepo.save(open);

      const live: LiveRun = { run: open, results, overrides: new Set([stageId]), cancelled: false };
      this.liveRuns.set(slug, live);
      const subject = new Subject<MessageEvent>();
      this.subjects.set(slug, subject);

      this.logger.log(`Run ${open.runId} retried from stage ${stageId} by ${triggeredBy}`);
      void this.execute(slug, stageId);
      return subject;
   }

   /** Re-opens the most recent terminal run so it can be retried from a stage. */
   public async reopenLastRun(slug: string, stageId: number, triggeredBy: string): Promise<Subject<MessageEvent>> {
      const open = await this.getOpenRun(slug);
      if (open) return this.retryStage(slug, stageId, triggeredBy);

      const last = await this.runRepo.findOne({ where: { pipelineSlug: slug }, order: { sequence: "DESC" } });
      if (!last) throw new Error(`No previous run for "${slug}"`);
      last.status = RunStatus.Running;
      last.finishedAt = null;
      last.error = null;
      last.blockedReason = null;
      last.currentStageId = stageId;
      await this.runRepo.save(last);
      return this.retryStage(slug, stageId, triggeredBy);
   }

   // ────────────────────────────────────────────────────────────────────────
   // Execution
   // ────────────────────────────────────────────────────────────────────────

   private async execute(slug: string, fromStageId: number, opts: { notifyStart?: boolean } = {}) {
      const live = this.liveRuns.get(slug);
      if (!live) {
         this.logger.error(`execute() called for "${slug}" with no live run`);
         return;
      }

      const graph = await this.loadGraph(slug);
      if (!graph) {
         await this.finalize(slug, live, RunStatus.Failed, `Pipeline "${slug}" disappeared mid-run`);
         return;
      }

      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, "enable_pipeline_deployment")) {
         await this.finalize(slug, live, RunStatus.Failed, "Deployments are disabled (feature flag: enable_pipeline_deployment)");
         return;
      }

      if (opts.notifyStart) {
         this.emit(slug, { type: "run_start", runId: live.run.runId, run: this.serializeRun(live) });
         void this.notify(slug, graph.pipeline.name, live, "started");
      }

      const stages = graph.stages;
      const startIndex = stages.findIndex((s) => s.id === fromStageId);
      if (startIndex === -1) {
         await this.finalize(slug, live, RunStatus.Failed, `Stage ${fromStageId} is not part of "${slug}"`);
         return;
      }

      for (let index = startIndex; index < stages.length; index++) {
         const stage = stages[index];
         if (live.cancelled) return;

         live.run.currentStageId = stage.id;

         // Re-read the pipeline each stage so the andon cord takes effect mid-run.
         const fresh = await this.pipelineRepo.findOneBy({ id: graph.pipeline.id });
         if (fresh?.disabled) {
            await this.pause(
               slug,
               live,
               RunStatus.Blocked,
               `Pipeline held${fresh.disabledBy ? ` by ${fresh.disabledBy}` : ""}${fresh.disabledMessage ? `: ${fresh.disabledMessage}` : ""}`,
               stage,
            );
            return;
         }

         const gate = await this.checkPromotionGate(slug, live, graph, stage, index);
         if (!gate.allowed) {
            await this.pause(slug, live, gate.status, gate.reason, stage, gate.blockedBy);
            return;
         }

         await this.applyWavePacing(graph, stages, index, slug);
         if (live.cancelled) return;

         const outcome = await this.runStage(slug, live, graph, stage);
         if (live.cancelled) return;

         if (outcome === "restarting") {
            // Record where to pick up and let the process die.
            const next = stages[index + 1];
            live.run.currentStageId = next ? next.id : null;
            live.run.status = next ? RunStatus.Running : RunStatus.Succeeded;
            if (!next) {
               await this.finalize(slug, live, RunStatus.Succeeded);
            } else {
               await this.persist(live);
            }
            return;
         }

         if (outcome === "failed") {
            const result = live.results[String(stage.id)];
            await this.finalize(slug, live, RunStatus.Failed, result?.error ?? `Stage "${stage.name}" failed`);
            return;
         }

         if (outcome === "success" && stage.approvalWorkflow?.enabled) {
            const workflowOutcome = await this.runWorkflow(slug, live, graph, stage);
            if (live.cancelled) return;
            if (workflowOutcome === "awaiting") {
               await this.pause(
                  slug,
                  live,
                  RunStatus.AwaitingApproval,
                  `Waiting for manual approval in workflow "${stage.approvalWorkflow.name}"`,
                  stage,
               );
               return;
            }
            if (workflowOutcome === "failed") {
               const result = live.results[String(stage.id)];
               await this.finalize(slug, live, RunStatus.Failed, result?.error ?? `Approval workflow for "${stage.name}" failed`);
               return;
            }
         }

         await this.persist(live);
      }

      await this.finalize(slug, live, RunStatus.Succeeded);
   }

   /**
    * Decides whether the run may enter `stage`, considering the incoming
    * promotion's automation state, the source stage's approval, and blockers.
    */
   private async checkPromotionGate(
      slug: string,
      live: LiveRun,
      graph: PipelineGraph,
      stage: PipelineStage,
      index: number,
   ): Promise<{ allowed: boolean; status: RunStatus; reason: string; blockedBy?: number[] }> {
      const ok = { allowed: true, status: RunStatus.Running, reason: "" };

      const promotion = graph.promotions.find((p) => p.destStageId === stage.id);
      // No promotion configured, or the very first stage: nothing gates entry.
      if (!promotion || index === 0) return ok;

      const overridden = live.overrides.has(stage.id);

      if (promotion.state === PromotionState.Disabled && !overridden) {
         return {
            allowed: false,
            status: RunStatus.Blocked,
            reason:
               `Promotion into "${stage.name}" is disabled` +
               `${promotion.disabledBy ? ` by ${promotion.disabledBy}` : ""}` +
               `${promotion.disabledMessage ? `: ${promotion.disabledMessage}` : ""}`,
         };
      }

      if (promotion.state === PromotionState.Off && !overridden) {
         return {
            allowed: false,
            status: RunStatus.Blocked,
            reason: `Automation is off for the promotion into "${stage.name}" — promote manually to continue`,
         };
      }

      if (promotion.requiresApproval && !overridden) {
         const sourceStage = promotion.sourceStageId
            ? graph.stages.find((s) => s.id === promotion.sourceStageId)
            : null;
         if (!sourceStage?.approvalWorkflow?.enabled) {
            return {
               allowed: false,
               status: RunStatus.Blocked,
               reason: `Promotion into "${stage.name}" requires approval but the source stage has no enabled approval workflow`,
            };
         }
         const sourceResult = live.results[String(sourceStage.id)];
         if (sourceResult?.workflow?.status !== "success") {
            return {
               allowed: false,
               status: RunStatus.AwaitingApproval,
               reason: `Revision is not approved by "${sourceStage.approvalWorkflow.name}" yet`,
            };
         }
      }

      if (promotion.bypassArmed) {
         // One-shot override: consume it and let the run through.
         promotion.bypassArmed = false;
         await this.promotionRepo.save(promotion);
         this.logger.warn(
            `Blockers bypassed for promotion into "${stage.name}" (armed by ${promotion.bypassArmedBy ?? "unknown"})`,
         );
         return ok;
      }

      if (overridden) return ok;

      const evaluation = await this.blockerService.evaluate(promotion.blockers);
      if (evaluation.isBlocked) {
         this.emit(slug, {
            type: "promotion_blocked",
            runId: live.run.runId,
            stageId: stage.id,
            stageName: stage.name,
            reason: evaluation.reason,
         });
         return {
            allowed: false,
            status: evaluation.awaitingApproval ? RunStatus.AwaitingApproval : RunStatus.Blocked,
            reason: evaluation.reason,
            blockedBy: evaluation.blocking.map((b) => b.blockerId),
         };
      }

      return ok;
   }

   /**
    * Waits out the wave's pacing rule before entering `stage`.
    *  - EXCLUSIVE: bake for `bakeTimeMinutes` after the previous member finished.
    *  - STAGGERED: hold `staggerMinutes` between consecutive members.
    * The first member of a wave never waits.
    */
   private async applyWavePacing(graph: PipelineGraph, stages: PipelineStage[], index: number, slug: string) {
      const stage = stages[index];
      if (!stage.waveId) return;
      const wave = graph.waves.find((w) => w.id === stage.waveId);
      if (!wave) return;

      const membersBefore = stages.slice(0, index).filter((s) => s.waveId === wave.id);
      if (membersBefore.length === 0) return;

      const minutes = wave.kind === "STAGGERED" ? wave.staggerMinutes : wave.bakeTimeMinutes;
      if (!minutes || minutes <= 0) return;

      const waitMs = minutes * 60_000;
      const label = wave.kind === "STAGGERED" ? "stagger" : "bake";
      this.emit(slug, {
         type: "stage_start",
         stageId: stage.id,
         stageName: stage.name,
         output: `Wave "${wave.name}": waiting ${minutes}m (${label}) before entering ${stage.name}\n`,
      });
      this.logger.log(`Wave "${wave.name}" ${label} of ${minutes}m before stage "${stage.name}"`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
   }

   /** Executes every target in a stage, sequentially. */
   private async runStage(
      slug: string,
      live: LiveRun,
      graph: PipelineGraph,
      stage: PipelineStage,
   ): Promise<StageOutcome> {
      const key = String(stage.id);
      const result: StageResult = live.results[key] ?? {
         stageId: stage.id,
         stageName: stage.name,
         kind: stage.kind,
         status: "pending",
         targets: {},
      };
      live.results[key] = result;

      if (!stage.enabled) {
         result.status = "skipped";
         result.finishedAt = new Date().toISOString();
         await this.persist(live);
         this.emit(slug, { type: "stage_complete", runId: live.run.runId, stageId: stage.id, stageName: stage.name, status: "skipped" });
         return "skipped";
      }

      result.status = "running";
      result.startedAt = result.startedAt ?? new Date().toISOString();
      result.blockedReason = undefined;
      result.error = undefined;
      await this.persist(live);
      this.emit(slug, { type: "stage_start", runId: live.run.runId, stageId: stage.id, stageName: stage.name });

      for (const target of stage.targets) {
         if (live.cancelled) return "failed";

         const step: StepResult = {
            key: target.name,
            name: target.name,
            status: "pending",
            output: "",
         };
         result.targets[target.name] = step;

         if (target.skip) {
            step.status = "skipped";
            step.output = "Skipped (disabled on the target)\n";
            step.finishedAt = new Date().toISOString();
            await this.persist(live);
            this.emit(slug, { type: "step_complete", runId: live.run.runId, stageId: stage.id, key: target.name, status: "skipped" });
            continue;
         }

         // Package stages describe sources rather than commands; a target with no
         // command is informational and always "succeeds".
         if (!target.cmd) {
            step.status = "success";
            step.startedAt = new Date().toISOString();
            step.finishedAt = step.startedAt;
            step.output = stage.kind === StageKind.Packages ? "Source target (no command)\n" : "No command configured\n";
            await this.persist(live);
            this.emit(slug, { type: "step_complete", runId: live.run.runId, stageId: stage.id, key: target.name, status: "success" });
            continue;
         }

         const cwd = this.runner.resolveWorkDir(target.workDir, graph.pipeline.workDir);

         // Replica fan-out: not a local command, so it bypasses the runner entirely.
         if (target.kind === TargetKind.Replica) {
            const succeeded = await this.runReplicaTarget(slug, live, stage.id, step, target.cmd);
            if (!succeeded) {
               result.status = "failed";
               result.error = `Replica target "${target.name}" failed: ${step.error}`;
               result.finishedAt = new Date().toISOString();
               await this.persist(live);
               this.emit(slug, {
                  type: "stage_complete",
                  runId: live.run.runId,
                  stageId: stage.id,
                  stageName: stage.name,
                  status: "failed",
                  error: result.error,
               });
               return "failed";
            }
            continue;
         }

         if (target.triggersRestart) {
            // Mark done *before* firing, because we are about to be killed.
            step.status = "success";
            step.startedAt = new Date().toISOString();
            step.finishedAt = step.startedAt;
            step.output = `Firing restart: ${target.cmd} ${target.getArgs().join(" ")}\nRemaining stages resume after boot.\n`;
            result.status = "success";
            result.finishedAt = new Date().toISOString();
            await this.persist(live);
            this.emit(slug, { type: "step_complete", runId: live.run.runId, stageId: stage.id, key: target.name, status: "success" });
            this.emit(slug, { type: "stage_complete", runId: live.run.runId, stageId: stage.id, stageName: stage.name, status: "success" });
            this.runner.spawnDetached(target.cmd, target.getArgs(), cwd);
            return "restarting";
         }

         const succeeded = await this.runWithRetries(slug, live, stage.id, step, {
            handle: `${live.run.runId}:stage${stage.id}:${target.name}`,
            cmd: target.cmd,
            args: target.getArgs(),
            cwd,
            timeoutMs: target.timeoutMs,
            maxAttempts: Math.max(1, target.maxAttempts),
         });

         if (!succeeded) {
            result.status = "failed";
            result.error = `Target "${target.name}" failed: ${step.error}`;
            result.finishedAt = new Date().toISOString();
            await this.persist(live);
            this.emit(slug, {
               type: "stage_complete",
               runId: live.run.runId,
               stageId: stage.id,
               stageName: stage.name,
               status: "failed",
               error: result.error,
            });
            return "failed";
         }
      }

      result.status = "success";
      result.finishedAt = new Date().toISOString();
      await this.persist(live);
      this.emit(slug, { type: "stage_complete", runId: live.run.runId, stageId: stage.id, stageName: stage.name, status: "success" });
      return "success";
   }

   /**
    * Runs a REPLICA target: propagate the deployment to every connected replica and
    * fold their reports back into this step.
    *
    * Policy, deliberately:
    *  - Any connected replica that fails, times out or drops fails the target.
    *  - A replica that *rejects* the task (it does not declare that task) is
    *    reported but does not fail the target — that is a statement about its
    *    configuration, not a broken deployment.
    *  - Zero connected replicas succeeds with a warning. Replicas are mirrors;
    *    blocking the primary's release because one is offline would be worse than
    *    the release going out unmirrored, and the run record says so plainly.
    */
   private async runReplicaTarget(
      slug: string,
      live: LiveRun,
      stageId: number,
      step: StepResult,
      task: string,
   ): Promise<boolean> {
      step.status = "running";
      step.startedAt = new Date().toISOString();
      step.attempt = 1;
      step.maxAttempts = 1;

      const emitOutput = (chunk: string) => {
         this.appendOutput(step, chunk);
         this.emit(slug, { type: "step_output", runId: live.run.runId, stageId, key: step.key, output: chunk });
      };

      if (!this.replicaDeployments) {
         // Only wired on a master boot; on any other topology this is a misconfiguration.
         step.status = "failed";
         step.error = "Replica deployment is not available on this node";
         step.finishedAt = new Date().toISOString();
         emitOutput(`${step.error}\n`);
         await this.persist(live);
         return false;
      }

      if (!task?.trim()) {
         step.status = "failed";
         step.error = "No replica task configured on this target";
         step.finishedAt = new Date().toISOString();
         emitOutput(`${step.error}\n`);
         await this.persist(live);
         return false;
      }

      this.emit(slug, {
         type: "step_start",
         runId: live.run.runId,
         stageId,
         key: step.key,
         startedAt: step.startedAt,
      });

      const connected = this.replicaDeployments.connectedCount();
      emitOutput(`Propagating task "${task}" to ${connected} connected replica(s)…\n`);

      const summary = await this.replicaDeployments.deploy(task, {
         revision: live.run.revision,
         commitSha: live.run.commitSha ?? undefined,
         onProgress: (event) => {
            const label = `${event.replica.deviceName} @ ${event.replica.ip}`;
            switch (event.type) {
               case "accepted":
                  emitOutput(`[${label}] accepted (${event.steps.length} step(s))\n`);
                  break;
               case "rejected":
                  emitOutput(`[${label}] rejected: ${event.reason}\n`);
                  break;
               case "output":
                  // Prefix every line so interleaved replica output stays attributable.
                  emitOutput(
                     event.chunk
                        .split("\n")
                        .map((line, index, lines) =>
                           index === lines.length - 1 && line === "" ? "" : `[${label}] ${line}\n`,
                        )
                        .join(""),
                  );
                  break;
               case "step":
                  emitOutput(`[${label}] ${event.step}: ${event.status}${event.error ? ` — ${event.error}` : ""}\n`);
                  break;
               case "settled":
                  emitOutput(`[${label}] ${event.state}${event.reason ? `: ${event.reason}` : ""}\n`);
                  break;
            }
         },
      });

      step.replicas = this.replicaReports(summary);

      if (summary.attempted === 0) {
         step.status = "success";
         step.finishedAt = new Date().toISOString();
         emitOutput("No replicas were connected — nothing was propagated.\n");
         await this.persist(live);
         this.emit(slug, {
            type: "step_complete",
            runId: live.run.runId,
            stageId,
            key: step.key,
            status: "success",
            finishedAt: step.finishedAt,
         });
         return true;
      }

      emitOutput(
         `Replica fan-out complete: ${summary.succeeded} succeeded, ${summary.failed} failed ` +
            `of ${summary.attempted} attempted.\n`,
      );

      step.status = summary.ok ? "success" : "failed";
      step.finishedAt = new Date().toISOString();
      if (!summary.ok) {
         step.error = summary.reports
            .filter((report) => ["failed", "timed_out", "disconnected"].includes(report.state))
            .map((report) => `${report.deviceName} @ ${report.ip}: ${report.state}${report.reason ? ` (${report.reason})` : ""}`)
            .join("; ");
      }
      await this.persist(live);
      this.emit(slug, {
         type: "step_complete",
         runId: live.run.runId,
         stageId,
         key: step.key,
         status: step.status,
         error: step.error,
         finishedAt: step.finishedAt,
      });
      return summary.ok;
   }

   /** Flattens a coordinator summary into the shape stored on the run. */
   private replicaReports(summary: ReplicaDeploymentSummary | null): ReplicaStepResult[] {
      if (!summary) return [];
      return summary.reports.map((report) => ({
         ip: report.ip,
         deviceName: report.deviceName,
         state: report.state,
         reason: report.reason,
         durationMs: report.durationMs,
         steps: report.steps.map((s) => ({ name: s.name, status: s.status, error: s.error, output: s.output })),
      }));
   }

   /** Runs one command with retry/backoff, streaming output into `step`. */
   private async runWithRetries(
      slug: string,
      live: LiveRun,
      stageId: number,
      step: StepResult,
      cmd: { handle: string; cmd: string; args: string[]; cwd: string; timeoutMs: number; maxAttempts: number },
   ): Promise<boolean> {
      step.maxAttempts = cmd.maxAttempts;

      for (let attempt = 1; attempt <= cmd.maxAttempts; attempt++) {
         if (live.cancelled) return false;

         step.attempt = attempt;
         step.status = "running";
         step.startedAt = new Date().toISOString();
         step.error = undefined;
         if (attempt > 1) {
            this.appendOutput(step, `\n--- Retry ${attempt}/${cmd.maxAttempts} ---\n`);
            this.emit(slug, {
               type: "step_output",
               runId: live.run.runId,
               stageId,
               key: step.key,
               output: `\n--- Retry ${attempt}/${cmd.maxAttempts} ---\n`,
            });
         }
         await this.persist(live);
         this.emit(slug, {
            type: "step_start",
            runId: live.run.runId,
            stageId,
            key: step.key,
            startedAt: step.startedAt,
            attempt,
            maxAttempts: cmd.maxAttempts,
         });

         try {
            const { exitCode } = await this.runner.run(cmd.handle, {
               cmd: cmd.cmd,
               args: cmd.args,
               cwd: cmd.cwd,
               timeoutMs: cmd.timeoutMs,
               onOutput: (chunk) => {
                  this.appendOutput(step, chunk);
                  this.emit(slug, { type: "step_output", runId: live.run.runId, stageId, key: step.key, output: chunk });
               },
            });
            step.status = "success";
            step.exitCode = exitCode;
            step.finishedAt = new Date().toISOString();
            await this.persist(live);
            this.emit(slug, {
               type: "step_complete",
               runId: live.run.runId,
               stageId,
               key: step.key,
               status: "success",
               finishedAt: step.finishedAt,
            });
            return true;
         } catch (error) {
            step.error = (error as Error).message;
            const isLast = attempt >= cmd.maxAttempts;
            this.appendOutput(step, `\nAttempt ${attempt} failed: ${step.error}\n`);
            this.emit(slug, {
               type: "step_output",
               runId: live.run.runId,
               stageId,
               key: step.key,
               output: `\nAttempt ${attempt} failed: ${step.error}\n`,
            });
            if (isLast) {
               step.status = "failed";
               step.finishedAt = new Date().toISOString();
               await this.persist(live);
               this.emit(slug, {
                  type: "step_complete",
                  runId: live.run.runId,
                  stageId,
                  key: step.key,
                  status: "failed",
                  error: step.error,
                  finishedAt: step.finishedAt,
               });
               return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
         }
      }
      return false;
   }

   /**
    * Runs a stage's approval workflow.
    *
    * Steps with satisfied dependencies run together; a manual step pauses the
    * workflow. With `rollbackOnFailure` a failure aborts the remaining waves
    * instead of letting in-flight siblings finish.
    */
   private async runWorkflow(
      slug: string,
      live: LiveRun,
      graph: PipelineGraph,
      stage: PipelineStage,
   ): Promise<WorkflowOutcome> {
      const workflow = stage.approvalWorkflow;
      if (!workflow) return "approved";

      const result = live.results[String(stage.id)];
      const steps = (workflow.steps ?? []).filter((s) => s.enabled);
      result.workflow = result.workflow ?? { name: workflow.name, status: "pending", steps: {} };
      const wf = result.workflow;
      wf.status = "running";
      await this.persist(live);
      this.emit(slug, { type: "workflow_start", runId: live.run.runId, stageId: stage.id, stageName: stage.name, key: workflow.name });

      if (steps.length === 0) {
         wf.status = "success";
         await this.persist(live);
         this.emit(slug, { type: "workflow_complete", runId: live.run.runId, stageId: stage.id, key: workflow.name, status: "success" });
         return "approved";
      }

      const byName = new Map(steps.map((s) => [s.name, s]));
      const statusOf = (name: string): StepStatus | undefined => wf.steps[name]?.status;

      // Loop until every step reaches a terminal state or nothing can progress.
      for (;;) {
         if (live.cancelled) return "failed";

         const ready = steps.filter((step) => {
            const status = statusOf(step.name);
            if (status && status !== "pending") return false;
            return step.getDependencies().every((dep) => {
               // A dependency on an unknown step can never be satisfied; surface it
               // as a failure rather than silently deadlocking.
               if (!byName.has(dep)) return false;
               return statusOf(dep) === "success" || statusOf(dep) === "skipped";
            });
         });

         const pending = steps.filter((step) => {
            const status = statusOf(step.name);
            return !status || status === "pending";
         });

         if (pending.length === 0) break;

         if (ready.length === 0) {
            const unsatisfied = pending
               .map((step) => {
                  const missing = step
                     .getDependencies()
                     .filter((dep) => !byName.has(dep) || statusOf(dep) !== "success");
                  return `${step.name} → [${missing.join(", ")}]`;
               })
               .join("; ");
            wf.status = "failed";
            result.error = `Approval workflow "${workflow.name}" cannot progress; unsatisfiable dependencies: ${unsatisfied}`;
            await this.persist(live);
            this.emit(slug, {
               type: "workflow_complete",
               runId: live.run.runId,
               stageId: stage.id,
               key: workflow.name,
               status: "failed",
               error: result.error,
            });
            return "failed";
         }

         // A manual step in the ready set pauses the whole workflow.
         const manual = ready.find((step) => step.manual);
         if (manual) {
            const step: StepResult = wf.steps[manual.name] ?? { key: manual.name, name: manual.name, status: "pending", output: "" };
            step.status = "awaiting_approval";
            step.startedAt = step.startedAt ?? new Date().toISOString();
            step.output += "Waiting for manual approval…\n";
            wf.steps[manual.name] = step;
            wf.status = "awaiting_approval";
            await this.persist(live);
            this.emit(slug, {
               type: "awaiting_approval",
               runId: live.run.runId,
               stageId: stage.id,
               stageName: stage.name,
               key: manual.name,
            });
            return "awaiting";
         }

         const outcomes = await Promise.all(
            ready.map(async (definition) => {
               const step: StepResult = { key: definition.name, name: definition.name, status: "pending", output: "" };
               wf.steps[definition.name] = step;
               this.emit(slug, {
                  type: "workflow_step_start",
                  runId: live.run.runId,
                  stageId: stage.id,
                  key: definition.name,
               });
               const cwd = this.runner.resolveWorkDir(definition.workDir, graph.pipeline.workDir);
               if (!definition.cmd) {
                  step.status = "skipped";
                  step.output = "No command configured\n";
                  step.finishedAt = new Date().toISOString();
                  return true;
               }
               const ok = await this.runWithRetries(slug, live, stage.id, step, {
                  handle: `${live.run.runId}:wf${workflow.id}:${definition.name}`,
                  cmd: definition.cmd,
                  args: definition.getArgs(),
                  cwd,
                  timeoutMs: definition.timeoutMs,
                  maxAttempts: Math.max(1, definition.maxAttempts),
               });
               this.emit(slug, {
                  type: "workflow_step_complete",
                  runId: live.run.runId,
                  stageId: stage.id,
                  key: definition.name,
                  status: step.status,
                  error: step.error,
               });
               return ok;
            }),
         );

         if (outcomes.some((ok) => !ok)) {
            if (workflow.rollbackOnFailure) this.runner.cancelAll(`${live.run.runId}:wf${workflow.id}:`);
            const failed = Object.values(wf.steps).filter((s) => s.status === "failed");
            wf.status = "failed";
            result.error = `Approval workflow "${workflow.name}" failed at ${failed.map((s) => s.name).join(", ")}`;
            await this.persist(live);
            this.emit(slug, {
               type: "workflow_complete",
               runId: live.run.runId,
               stageId: stage.id,
               key: workflow.name,
               status: "failed",
               error: result.error,
            });
            return "failed";
         }
      }

      wf.status = "success";
      wf.approvedAt = wf.approvedAt ?? new Date().toISOString();
      wf.approvedBy = wf.approvedBy ?? workflow.name;
      await this.persist(live);
      this.emit(slug, { type: "workflow_complete", runId: live.run.runId, stageId: stage.id, key: workflow.name, status: "success" });
      return "approved";
   }

   // ────────────────────────────────────────────────────────────────────────
   // Built-commit resolution
   // ────────────────────────────────────────────────────────────────────────

   /**
    * Reads the commit currently checked out in the pipeline's working directory.
    *
    * Manually started runs have no webhook payload, so without this the "built
    * commit" would be blank for exactly the runs an operator kicks off by hand.
    * Every failure mode (no git, not a repository, shallow clone) simply yields
    * null rather than blocking the run.
    */
   private async resolveLocalCommit(pipeline: Pipeline): Promise<BuiltCommitInfo | null> {
      // Only inspect a directory the pipeline actually points at. `resolveWorkDir`
      // falls back to process.cwd() for an empty value, which would misattribute
      // the API's own HEAD to a pipeline that builds something else entirely.
      if (!pipeline.workDir) return null;

      const cwd = this.runner.resolveWorkDir(pipeline.workDir);
      // %H sha, %s subject, %an author, %aI author date — separated by unit separators.
      const raw = await this.runner.capture(
         "git",
         ["log", "-1", "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"],
         cwd,
         3_000,
      );
      if (!raw) return null;

      const [sha, message, author, isoDate] = raw.split("\x1f");
      if (!sha) return null;

      const [branch, describedTag, remote] = await Promise.all([
         this.runner.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 3_000),
         this.runner.capture("git", ["describe", "--tags", "--exact-match"], cwd, 3_000),
         this.runner.capture("git", ["config", "--get", "remote.origin.url"], cwd, 3_000),
      ]);

      const repository = this.parseRepositorySlug(remote);
      const committedAt = isoDate ? new Date(isoDate) : null;
      const isTag = !!describedTag;

      return {
         sha,
         shortSha: shortenSha(sha),
         message: message?.trim() || null,
         url: repository && sha ? `https://github.com/${repository}/commit/${sha}` : null,
         authorName: author?.trim() || null,
         authorUsername: null,
         committedAt: committedAt && !Number.isNaN(committedAt.getTime()) ? committedAt : null,
         ref: isTag ? `refs/tags/${describedTag}` : branch ? `refs/heads/${branch}` : null,
         refName: isTag ? describedTag : branch || null,
         // Flagged as local so the UI can distinguish "what is on disk" from
         // "what GitHub told us was pushed".
         refType: isTag ? "tag" : "branch",
         repository,
         compareUrl: null,
         changedFiles: [],
         pushedBy: null,
      };
   }

   /** `git@github.com:Owner/Repo.git` / `https://github.com/Owner/Repo.git` → `Owner/Repo`. */
   private parseRepositorySlug(remote: string | null): string | null {
      if (!remote) return null;
      const match = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/i.exec(remote.trim());
      return match ? match[1] : null;
   }

   // ────────────────────────────────────────────────────────────────────────
   // Run state helpers
   // ────────────────────────────────────────────────────────────────────────

   private appendOutput(step: StepResult, chunk: string) {
      step.output += chunk;
      if (step.output.length > MAX_STEP_OUTPUT) {
         const dropped = step.output.length - MAX_STEP_OUTPUT;
         step.output = `…[${dropped} earlier bytes trimmed]…\n` + step.output.slice(-MAX_STEP_OUTPUT);
      }
   }

   private async persist(live: LiveRun) {
      live.run.setStageResults(live.results);
      try {
         await this.runRepo.save(live.run);
      } catch (e) {
         this.logger.error(`Failed to persist run ${live.run.runId}: ${(e as Error).message}`);
      }
   }

   /** Halts the run in a resumable state. */
   private async pause(
      slug: string,
      live: LiveRun,
      status: RunStatus,
      reason: string,
      stage: PipelineStage,
      blockedBy?: number[],
   ) {
      const key = String(stage.id);
      const result: StageResult = live.results[key] ?? {
         stageId: stage.id,
         stageName: stage.name,
         kind: stage.kind,
         status: "pending",
         targets: {},
      };
      result.status = status === RunStatus.AwaitingApproval ? "awaiting_approval" : "blocked";
      result.blockedReason = reason;
      result.blockedBy = blockedBy;
      live.results[key] = result;

      live.run.status = status;
      live.run.blockedReason = reason;
      live.run.currentStageId = stage.id;
      await this.persist(live);

      this.emit(slug, {
         type: status === RunStatus.AwaitingApproval ? "awaiting_approval" : "promotion_blocked",
         runId: live.run.runId,
         stageId: stage.id,
         stageName: stage.name,
         reason,
         run: this.serializeRun(live),
      });
      this.closeStream(slug);
      this.logger.log(`Run ${live.run.runId} paused (${status}) at "${stage.name}": ${reason}`);
   }

   private async finalize(slug: string, live: LiveRun, status: RunStatus, error?: string) {
      live.run.status = status;
      live.run.error = error ?? null;
      live.run.finishedAt = new Date();
      live.run.durationMs = live.run.startedAt
         ? live.run.finishedAt.getTime() - new Date(live.run.startedAt).getTime()
         : 0;
      live.run.currentStageId = null;
      live.run.blockedReason = null;
      await this.persist(live);

      // Re-arm one-shot gates so the next run stops at them again.
      const graph = await this.loadGraph(slug);
      for (const promotion of graph?.promotions ?? []) {
         for (const blocker of promotion.blockers ?? []) {
            if (blocker.kind === BlockerKind.ManualApproval && blocker.state === BlockerState.Ok) {
               await this.blockerService.rearm(blocker.id);
            }
         }
      }

      this.emit(slug, { type: "run_complete", runId: live.run.runId, run: this.serializeRun(live) });
      this.closeStream(slug);
      this.liveRuns.delete(slug);

      if (status === RunStatus.Succeeded) {
         this.logger.log(`Run ${live.run.runId} of "${slug}" succeeded in ${Math.round(live.run.durationMs / 1000)}s`);
      } else {
         this.logger.error(`Run ${live.run.runId} of "${slug}" ${status}: ${error ?? "unknown error"}`);
      }

      void this.notify(slug, graph?.pipeline.name ?? slug, live, status === RunStatus.Succeeded ? "succeeded" : "failed");
      void this.processQueue(slug);
   }

   private emit(slug: string, event: PipelineEvent) {
      const subject = this.subjects.get(slug);
      if (!subject || subject.closed) return;
      subject.next({ data: JSON.stringify(event) } as MessageEvent);
   }

   private closeStream(slug: string) {
      const subject = this.subjects.get(slug);
      if (!subject) return;
      subject.complete();
      this.subjects.delete(slug);
   }

   public serializeRun(live: LiveRun) {
      return {
         ...this.serializeRunEntity(live.run),
         stageResults: live.results,
      };
   }

   public serializeRunEntity(run: PipelineRun) {
      return {
         id: run.id,
         runId: run.runId,
         pipelineSlug: run.pipelineSlug,
         sequence: run.sequence,
         revision: run.revision,
         status: run.status,
         triggeredBy: run.triggeredBy,
         commitMessage: run.commitMessage,
         currentStageId: run.currentStageId,
         startedAt: run.startedAt,
         finishedAt: run.finishedAt,
         durationMs: run.durationMs,
         error: run.error,
         blockedReason: run.blockedReason,
         stageResults: run.getStageResults(),
         commit: this.serializeCommit(run),
      };
   }

   /** The "built commit" block rendered by the UI. Null when nothing was captured. */
   private serializeCommit(run: PipelineRun) {
      if (!run.commitSha && !run.gitRefName && !run.commitMessage) return null;
      return {
         sha: run.commitSha,
         shortSha: shortenSha(run.commitSha),
         message: run.commitMessage,
         url: run.commitUrl,
         authorName: run.commitAuthor,
         authorUsername: run.commitAuthorUsername,
         committedAt: run.commitTimestamp,
         ref: run.gitRef,
         refName: run.gitRefName,
         refType: run.gitRefType,
         repository: run.repositoryName,
         compareUrl: run.compareUrl,
         changedFiles: run.getChangedFiles(),
         pushedBy: run.pushedBy,
      };
   }

   // ────────────────────────────────────────────────────────────────────────
   // Notifications
   // ────────────────────────────────────────────────────────────────────────

   private async notify(slug: string, pipelineName: string, live: LiveRun, phase: "started" | "succeeded" | "failed") {
      try {
         if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, "allow_deployment_email_sending")) {
            return;
         }
         const frontendUrl = this.config.get("this-service.frontend_url", { infer: true }) || "";
         const url = `${frontendUrl}/admin/pipelines/${slug}`;
         const palette = {
            started: { bg: "#0972d3", label: "In progress", title: "Pipeline run started" },
            succeeded: { bg: "#037f0c", label: "Succeeded", title: "Pipeline run succeeded" },
            failed: { bg: "#d91515", label: "Failed", title: "Pipeline run failed" },
         }[phase];

         const rows: [string, string][] = [
            ["Pipeline", pipelineName],
            ["Run", `#${live.run.sequence} (${live.run.revision})`],
            ["Triggered by", live.run.triggeredBy],
         ];
         if (live.run.durationMs) rows.push(["Duration", `${Math.round(live.run.durationMs / 1000)}s`]);
         if (live.run.error) rows.push(["Error", live.run.error]);

         await this.emailService.sendEmail({
            subject: `Shado Cloud — ${pipelineName} run #${live.run.sequence} ${palette.label.toLowerCase()}`,
            html: this.buildEmailHtml(palette, rows, url),
         });
      } catch (e) {
         this.logger.error(`Failed to send pipeline notification: ${(e as Error).message}`);
      }
   }

   private buildEmailHtml(
      palette: { bg: string; label: string; title: string },
      rows: [string, string][],
      url: string,
   ): string {
      const escape = (value: string) =>
         value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const cells = rows
         .map(
            ([label, value]) => `
            <tr>
               <td style="padding:8px 0;color:#5f6b7a;font-size:13px;">${escape(label)}</td>
               <td style="padding:8px 0;text-align:right;font-size:13px;font-weight:600;color:#0f1b2a;">${escape(value)}</td>
            </tr>`,
         )
         .join("");

      return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f2f3f3;padding:32px 16px;margin:0;">
   <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d5dbdb;border-radius:8px;overflow:hidden;">
      <div style="background:${palette.bg};padding:20px 24px;">
         <h1 style="color:#ffffff;margin:0;font-size:18px;font-weight:700;">${escape(palette.title)}</h1>
      </div>
      <div style="padding:20px 24px;">
         <table style="width:100%;border-collapse:collapse;">${cells}</table>
         <a href="${escape(url)}" style="display:block;margin-top:20px;padding:10px;background:#0f1b2a;color:#ffffff;text-align:center;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">View pipeline</a>
      </div>
   </div>
</body>
</html>`;
   }
}
