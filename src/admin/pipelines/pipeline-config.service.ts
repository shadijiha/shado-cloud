import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Pipeline } from "src/models/admin/pipeline/pipeline";
import { PipelineWave } from "src/models/admin/pipeline/pipelineWave";
import { PipelineStage } from "src/models/admin/pipeline/pipelineStage";
import { PipelineTarget } from "src/models/admin/pipeline/pipelineTarget";
import { PipelinePromotion } from "src/models/admin/pipeline/pipelinePromotion";
import { PipelinePromotionBlocker } from "src/models/admin/pipeline/pipelinePromotionBlocker";
import { ApprovalWorkflow } from "src/models/admin/pipeline/approvalWorkflow";
import { ApprovalWorkflowStep } from "src/models/admin/pipeline/approvalWorkflowStep";
import {
   BlockerKind,
   BlockerState,
   PromotionKind,
   PromotionState,
   StageKind,
   TargetKind,
   WaveKind,
} from "src/models/admin/pipeline/pipeline.types";

/** Payloads accepted by the editor endpoints. Everything is optional on update. */
export interface PipelineInput {
   slug?: string;
   name?: string;
   description?: string | null;
   workDir?: string;
   branch?: string;
   pm2ProcessName?: string | null;
   owner?: string | null;
   enabled?: boolean;
   triggerOnTags?: boolean;
   tagPattern?: string;
}

export interface WaveInput {
   name?: string;
   kind?: WaveKind;
   position?: number;
   bakeTimeMinutes?: number;
   staggerMinutes?: number;
   accentColor?: string;
}

export interface StageInput {
   name?: string;
   kind?: StageKind;
   waveId?: number | null;
   position?: number;
   isProd?: boolean;
   description?: string | null;
   enabled?: boolean;
}

export interface TargetInput {
   name?: string;
   kind?: TargetKind;
   position?: number;
   cmd?: string;
   args?: string[];
   workDir?: string;
   url?: string | null;
   triggersRestart?: boolean;
   skip?: boolean;
   maxAttempts?: number;
   timeoutMs?: number;
}

export interface PromotionInput {
   sourceStageId?: number | null;
   destStageId?: number;
   kind?: PromotionKind;
   state?: PromotionState;
   requiresApproval?: boolean;
   approvalName?: string | null;
}

export interface BlockerInput {
   kind?: BlockerKind;
   name?: string;
   description?: string | null;
   config?: Record<string, unknown>;
   state?: BlockerState;
   enabled?: boolean;
}

export interface WorkflowInput {
   name?: string;
   rollbackOnFailure?: boolean;
   requiresConsistentRevisions?: boolean;
   enabled?: boolean;
}

export interface WorkflowStepInput {
   name?: string;
   position?: number;
   manual?: boolean;
   cmd?: string;
   args?: string[];
   workDir?: string;
   dependencies?: string[];
   maxAttempts?: number;
   timeoutMs?: number;
   enabled?: boolean;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * All write operations on the pipeline *configuration* (as opposed to running it).
 * Kept separate from the execution engine so the engine only ever reads.
 */
@Injectable()
export class PipelineConfigService {
   private readonly logger = new Logger(PipelineConfigService.name);

   constructor(
      @InjectRepository(Pipeline) private readonly pipelineRepo: Repository<Pipeline>,
      @InjectRepository(PipelineWave) private readonly waveRepo: Repository<PipelineWave>,
      @InjectRepository(PipelineStage) private readonly stageRepo: Repository<PipelineStage>,
      @InjectRepository(PipelineTarget) private readonly targetRepo: Repository<PipelineTarget>,
      @InjectRepository(PipelinePromotion) private readonly promotionRepo: Repository<PipelinePromotion>,
      @InjectRepository(PipelinePromotionBlocker) private readonly blockerRepo: Repository<PipelinePromotionBlocker>,
      @InjectRepository(ApprovalWorkflow) private readonly workflowRepo: Repository<ApprovalWorkflow>,
      @InjectRepository(ApprovalWorkflowStep) private readonly workflowStepRepo: Repository<ApprovalWorkflowStep>,
   ) {}

   // ── lookups ──────────────────────────────────────────────────────────────

   private async requirePipeline(slug: string): Promise<Pipeline> {
      const pipeline = await this.pipelineRepo.findOneBy({ slug });
      if (!pipeline) throw new NotFoundException(`Pipeline "${slug}" not found`);
      return pipeline;
   }

   /** Loads a stage and asserts it belongs to `slug`, so ids cannot cross pipelines. */
   private async requireStage(slug: string, stageId: number): Promise<PipelineStage> {
      const pipeline = await this.requirePipeline(slug);
      const stage = await this.stageRepo.findOneBy({ id: stageId });
      if (!stage || stage.pipelineId !== pipeline.id) {
         throw new NotFoundException(`Stage ${stageId} not found in pipeline "${slug}"`);
      }
      return stage;
   }

   private async requirePromotion(slug: string, promotionId: number): Promise<PipelinePromotion> {
      const pipeline = await this.requirePipeline(slug);
      const promotion = await this.promotionRepo.findOne({ where: { id: promotionId }, relations: { blockers: true } });
      if (!promotion || promotion.pipelineId !== pipeline.id) {
         throw new NotFoundException(`Promotion ${promotionId} not found in pipeline "${slug}"`);
      }
      return promotion;
   }

   // ── pipeline ─────────────────────────────────────────────────────────────

   public async createPipeline(input: PipelineInput): Promise<Pipeline> {
      if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
         throw new BadRequestException("slug must be lowercase alphanumeric with dashes (max 63 chars)");
      }
      if (!input.name) throw new BadRequestException("name is required");
      const clash = await this.pipelineRepo.findOneBy({ slug: input.slug });
      if (clash) throw new BadRequestException(`Pipeline "${input.slug}" already exists`);

      return this.pipelineRepo.save(
         this.pipelineRepo.create({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            workDir: input.workDir ?? "",
            branch: input.branch ?? "master",
            pm2ProcessName: input.pm2ProcessName ?? null,
            owner: input.owner ?? null,
            enabled: input.enabled ?? true,
            triggerOnTags: input.triggerOnTags ?? true,
            tagPattern: input.tagPattern ?? "",
            disabled: false,
         }),
      );
   }

   public async updatePipeline(slug: string, input: PipelineInput): Promise<Pipeline> {
      const pipeline = await this.requirePipeline(slug);
      if (input.slug !== undefined && input.slug !== pipeline.slug) {
         if (!SLUG_PATTERN.test(input.slug)) throw new BadRequestException("Invalid slug");
         const clash = await this.pipelineRepo.findOneBy({ slug: input.slug });
         if (clash) throw new BadRequestException(`Pipeline "${input.slug}" already exists`);
         pipeline.slug = input.slug;
      }
      if (input.name !== undefined) pipeline.name = input.name;
      if (input.description !== undefined) pipeline.description = input.description;
      if (input.workDir !== undefined) pipeline.workDir = input.workDir;
      if (input.branch !== undefined) pipeline.branch = input.branch;
      if (input.pm2ProcessName !== undefined) pipeline.pm2ProcessName = input.pm2ProcessName;
      if (input.owner !== undefined) pipeline.owner = input.owner;
      if (input.enabled !== undefined) pipeline.enabled = input.enabled;
      if (input.triggerOnTags !== undefined) pipeline.triggerOnTags = input.triggerOnTags;
      if (input.tagPattern !== undefined) pipeline.tagPattern = input.tagPattern;
      return this.pipelineRepo.save(pipeline);
   }

   public async deletePipeline(slug: string): Promise<void> {
      const pipeline = await this.requirePipeline(slug);
      // Children are removed by ON DELETE CASCADE.
      await this.pipelineRepo.delete({ id: pipeline.id });
      this.logger.log(`Deleted pipeline "${slug}"`);
   }

   /** The andon cord: holds or releases every automated promotion in the pipeline. */
   public async setPipelineHold(
      slug: string,
      hold: boolean,
      actor: string,
      message?: string,
   ): Promise<Pipeline> {
      const pipeline = await this.requirePipeline(slug);
      pipeline.disabled = hold;
      pipeline.disabledBy = hold ? actor : null;
      pipeline.disabledMessage = hold ? (message ?? null) : null;
      pipeline.disabledAt = hold ? new Date() : null;
      this.logger.warn(`Pipeline "${slug}" ${hold ? "held" : "released"} by ${actor}${message ? `: ${message}` : ""}`);
      return this.pipelineRepo.save(pipeline);
   }

   // ── waves ────────────────────────────────────────────────────────────────

   public async createWave(slug: string, input: WaveInput): Promise<PipelineWave> {
      const pipeline = await this.requirePipeline(slug);
      if (!input.name) throw new BadRequestException("name is required");
      const count = await this.waveRepo.count({ where: { pipelineId: pipeline.id } });
      return this.waveRepo.save(
         this.waveRepo.create({
            pipelineId: pipeline.id,
            name: input.name,
            kind: input.kind ?? WaveKind.Exclusive,
            position: input.position ?? count,
            bakeTimeMinutes: input.bakeTimeMinutes ?? 0,
            staggerMinutes: input.staggerMinutes ?? 0,
            accentColor: input.accentColor ?? "#5f6b7a",
         }),
      );
   }

   public async updateWave(slug: string, waveId: number, input: WaveInput): Promise<PipelineWave> {
      const pipeline = await this.requirePipeline(slug);
      const wave = await this.waveRepo.findOneBy({ id: waveId });
      if (!wave || wave.pipelineId !== pipeline.id) throw new NotFoundException(`Wave ${waveId} not found`);
      Object.assign(wave, {
         name: input.name ?? wave.name,
         kind: input.kind ?? wave.kind,
         position: input.position ?? wave.position,
         bakeTimeMinutes: input.bakeTimeMinutes ?? wave.bakeTimeMinutes,
         staggerMinutes: input.staggerMinutes ?? wave.staggerMinutes,
         accentColor: input.accentColor ?? wave.accentColor,
      });
      return this.waveRepo.save(wave);
   }

   public async deleteWave(slug: string, waveId: number): Promise<void> {
      const pipeline = await this.requirePipeline(slug);
      const wave = await this.waveRepo.findOneBy({ id: waveId });
      if (!wave || wave.pipelineId !== pipeline.id) throw new NotFoundException(`Wave ${waveId} not found`);
      // Stages fall back to "no wave" rather than being deleted with it.
      await this.stageRepo.update({ waveId }, { waveId: null });
      await this.waveRepo.delete({ id: waveId });
   }

   // ── stages ───────────────────────────────────────────────────────────────

   public async createStage(slug: string, input: StageInput): Promise<PipelineStage> {
      const pipeline = await this.requirePipeline(slug);
      if (!input.name) throw new BadRequestException("name is required");
      const count = await this.stageRepo.count({ where: { pipelineId: pipeline.id } });
      return this.stageRepo.save(
         this.stageRepo.create({
            pipelineId: pipeline.id,
            waveId: input.waveId ?? null,
            name: input.name,
            kind: input.kind ?? StageKind.Generic,
            position: input.position ?? count,
            isProd: input.isProd ?? false,
            description: input.description ?? null,
            enabled: input.enabled ?? true,
         }),
      );
   }

   public async updateStage(slug: string, stageId: number, input: StageInput): Promise<PipelineStage> {
      const stage = await this.requireStage(slug, stageId);
      if (input.name !== undefined) stage.name = input.name;
      if (input.kind !== undefined) stage.kind = input.kind;
      if (input.waveId !== undefined) stage.waveId = input.waveId;
      if (input.position !== undefined) stage.position = input.position;
      if (input.isProd !== undefined) stage.isProd = input.isProd;
      if (input.description !== undefined) stage.description = input.description;
      if (input.enabled !== undefined) stage.enabled = input.enabled;
      return this.stageRepo.save(stage);
   }

   public async deleteStage(slug: string, stageId: number): Promise<void> {
      const stage = await this.requireStage(slug, stageId);
      // Re-wire the graph so removing a middle stage does not sever the chain:
      // A → stage → B becomes A → B.
      const incoming = await this.promotionRepo.findOne({ where: { destStageId: stage.id } });
      const outgoing = await this.promotionRepo.find({ where: { sourceStageId: stage.id } });
      for (const promotion of outgoing) {
         promotion.sourceStageId = incoming?.sourceStageId ?? null;
         await this.promotionRepo.save(promotion);
      }
      if (incoming) await this.promotionRepo.delete({ id: incoming.id });
      await this.stageRepo.delete({ id: stage.id });
      await this.normalizeStagePositions(stage.pipelineId);
   }

   /** Applies a new left-to-right ordering from a list of stage ids. */
   public async reorderStages(slug: string, orderedStageIds: number[]): Promise<PipelineStage[]> {
      const pipeline = await this.requirePipeline(slug);
      const stages = await this.stageRepo.find({ where: { pipelineId: pipeline.id } });
      const known = new Set(stages.map((s) => s.id));
      for (const id of orderedStageIds) {
         if (!known.has(id)) throw new BadRequestException(`Stage ${id} is not part of "${slug}"`);
      }
      if (orderedStageIds.length !== stages.length) {
         throw new BadRequestException(`Expected ${stages.length} stage ids, received ${orderedStageIds.length}`);
      }
      for (const [position, id] of orderedStageIds.entries()) {
         await this.stageRepo.update({ id }, { position });
      }
      return this.stageRepo.find({ where: { pipelineId: pipeline.id }, order: { position: "ASC" } });
   }

   private async normalizeStagePositions(pipelineId: number) {
      const stages = await this.stageRepo.find({ where: { pipelineId }, order: { position: "ASC", id: "ASC" } });
      for (const [position, stage] of stages.entries()) {
         if (stage.position !== position) await this.stageRepo.update({ id: stage.id }, { position });
      }
   }

   // ── targets ──────────────────────────────────────────────────────────────

   public async createTarget(slug: string, stageId: number, input: TargetInput): Promise<PipelineTarget> {
      const stage = await this.requireStage(slug, stageId);
      if (!input.name) throw new BadRequestException("name is required");
      const siblings = await this.targetRepo.find({ where: { stageId: stage.id } });
      if (siblings.some((t) => t.name === input.name)) {
         throw new BadRequestException(`Target "${input.name}" already exists in this stage`);
      }
      const target = this.targetRepo.create({
         stageId: stage.id,
         name: input.name,
         kind: input.kind ?? TargetKind.Generic,
         position: input.position ?? siblings.length,
         cmd: input.cmd ?? "",
         workDir: input.workDir ?? "",
         url: input.url ?? null,
         triggersRestart: input.triggersRestart ?? false,
         skip: input.skip ?? false,
         maxAttempts: input.maxAttempts ?? 3,
         timeoutMs: input.timeoutMs ?? 0,
      });
      target.setArgs(input.args ?? []);
      return this.targetRepo.save(target);
   }

   public async updateTarget(slug: string, targetId: number, input: TargetInput): Promise<PipelineTarget> {
      const target = await this.targetRepo.findOneBy({ id: targetId });
      if (!target) throw new NotFoundException(`Target ${targetId} not found`);
      await this.requireStage(slug, target.stageId);

      if (input.name !== undefined && input.name !== target.name) {
         const siblings = await this.targetRepo.find({ where: { stageId: target.stageId } });
         if (siblings.some((t) => t.id !== target.id && t.name === input.name)) {
            throw new BadRequestException(`Target "${input.name}" already exists in this stage`);
         }
         target.name = input.name;
      }
      if (input.kind !== undefined) target.kind = input.kind;
      if (input.position !== undefined) target.position = input.position;
      if (input.cmd !== undefined) target.cmd = input.cmd;
      if (input.args !== undefined) target.setArgs(input.args);
      if (input.workDir !== undefined) target.workDir = input.workDir;
      if (input.url !== undefined) target.url = input.url;
      if (input.triggersRestart !== undefined) target.triggersRestart = input.triggersRestart;
      if (input.skip !== undefined) target.skip = input.skip;
      if (input.maxAttempts !== undefined) target.maxAttempts = Math.max(1, input.maxAttempts);
      if (input.timeoutMs !== undefined) target.timeoutMs = Math.max(0, input.timeoutMs);
      return this.targetRepo.save(target);
   }

   public async deleteTarget(slug: string, targetId: number): Promise<void> {
      const target = await this.targetRepo.findOneBy({ id: targetId });
      if (!target) throw new NotFoundException(`Target ${targetId} not found`);
      await this.requireStage(slug, target.stageId);
      await this.targetRepo.delete({ id: targetId });
   }

   // ── promotions ───────────────────────────────────────────────────────────

   public async createPromotion(slug: string, input: PromotionInput): Promise<PipelinePromotion> {
      const pipeline = await this.requirePipeline(slug);
      if (!input.destStageId) throw new BadRequestException("destStageId is required");
      const dest = await this.requireStage(slug, input.destStageId);
      if (input.sourceStageId) await this.requireStage(slug, input.sourceStageId);
      if (input.sourceStageId === input.destStageId) {
         throw new BadRequestException("A promotion cannot start and end at the same stage");
      }
      const existing = await this.promotionRepo.findOne({ where: { destStageId: dest.id } });
      if (existing) {
         throw new BadRequestException(`Stage "${dest.name}" already has an incoming promotion`);
      }

      return this.promotionRepo.save(
         this.promotionRepo.create({
            pipelineId: pipeline.id,
            sourceStageId: input.sourceStageId ?? null,
            destStageId: dest.id,
            kind: input.kind ?? PromotionKind.Generic,
            state: input.state ?? PromotionState.On,
            requiresApproval: input.requiresApproval ?? false,
            approvalName: input.approvalName ?? null,
         }),
      );
   }

   public async updatePromotion(slug: string, promotionId: number, input: PromotionInput): Promise<PipelinePromotion> {
      const promotion = await this.requirePromotion(slug, promotionId);
      if (input.sourceStageId !== undefined) {
         if (input.sourceStageId !== null) await this.requireStage(slug, input.sourceStageId);
         if (input.sourceStageId === promotion.destStageId) {
            throw new BadRequestException("A promotion cannot start and end at the same stage");
         }
         promotion.sourceStageId = input.sourceStageId;
      }
      if (input.kind !== undefined) promotion.kind = input.kind;
      if (input.requiresApproval !== undefined) promotion.requiresApproval = input.requiresApproval;
      if (input.approvalName !== undefined) promotion.approvalName = input.approvalName;
      if (input.state !== undefined) promotion.state = input.state;
      return this.promotionRepo.save(promotion);
   }

   public async deletePromotion(slug: string, promotionId: number): Promise<void> {
      const promotion = await this.requirePromotion(slug, promotionId);
      await this.promotionRepo.delete({ id: promotion.id });
   }

   /** Turns a promotion's automation on/off/disabled, recording who and why. */
   public async setPromotionState(
      slug: string,
      promotionId: number,
      state: PromotionState,
      actor: string,
      message?: string,
   ): Promise<PipelinePromotion> {
      const promotion = await this.requirePromotion(slug, promotionId);
      promotion.state = state;
      if (state === PromotionState.Disabled) {
         promotion.disabledBy = actor;
         promotion.disabledMessage = message ?? null;
         promotion.disabledAt = new Date();
      } else {
         promotion.disabledBy = null;
         promotion.disabledMessage = null;
         promotion.disabledAt = null;
      }
      this.logger.warn(`Promotion ${promotionId} in "${slug}" set to ${state} by ${actor}`);
      return this.promotionRepo.save(promotion);
   }

   /** Arms a one-shot bypass so the next promotion attempt ignores its blockers. */
   public async armBypass(slug: string, promotionId: number, actor: string): Promise<PipelinePromotion> {
      const promotion = await this.requirePromotion(slug, promotionId);
      if ((promotion.blockers ?? []).filter((b) => b.enabled).length === 0) {
         throw new BadRequestException("This promotion has no blockers to bypass");
      }
      promotion.bypassArmed = true;
      promotion.bypassArmedBy = actor;
      promotion.bypassArmedAt = new Date();
      this.logger.warn(`Blocker bypass armed on promotion ${promotionId} of "${slug}" by ${actor}`);
      return this.promotionRepo.save(promotion);
   }

   public async clearBypass(slug: string, promotionId: number): Promise<PipelinePromotion> {
      const promotion = await this.requirePromotion(slug, promotionId);
      promotion.bypassArmed = false;
      promotion.bypassArmedBy = null;
      promotion.bypassArmedAt = null;
      return this.promotionRepo.save(promotion);
   }

   // ── blockers ─────────────────────────────────────────────────────────────

   public async createBlocker(slug: string, promotionId: number, input: BlockerInput): Promise<PipelinePromotionBlocker> {
      const promotion = await this.requirePromotion(slug, promotionId);
      if (!input.kind) throw new BadRequestException("kind is required");
      if (!input.name) throw new BadRequestException("name is required");
      const blocker = this.blockerRepo.create({
         promotionId: promotion.id,
         kind: input.kind,
         name: input.name,
         description: input.description ?? null,
         // Manual gates and locks start armed; automatic blockers start clear and
         // are resolved on evaluation.
         state:
            input.state ??
            (input.kind === BlockerKind.ManualApproval || input.kind === BlockerKind.Lock
               ? BlockerState.Blocking
               : BlockerState.Ok),
         enabled: input.enabled ?? true,
      });
      blocker.setConfig(input.config ?? {});
      return this.blockerRepo.save(blocker);
   }

   public async updateBlocker(slug: string, blockerId: number, input: BlockerInput): Promise<PipelinePromotionBlocker> {
      const blocker = await this.blockerRepo.findOneBy({ id: blockerId });
      if (!blocker) throw new NotFoundException(`Blocker ${blockerId} not found`);
      await this.requirePromotion(slug, blocker.promotionId);

      if (input.kind !== undefined) blocker.kind = input.kind;
      if (input.name !== undefined) blocker.name = input.name;
      if (input.description !== undefined) blocker.description = input.description;
      if (input.config !== undefined) blocker.setConfig(input.config);
      if (input.enabled !== undefined) blocker.enabled = input.enabled;
      if (input.state !== undefined && input.state !== blocker.state) {
         blocker.state = input.state;
         blocker.lastStateChange = new Date();
      }
      return this.blockerRepo.save(blocker);
   }

   public async deleteBlocker(slug: string, blockerId: number): Promise<void> {
      const blocker = await this.blockerRepo.findOneBy({ id: blockerId });
      if (!blocker) throw new NotFoundException(`Blocker ${blockerId} not found`);
      await this.requirePromotion(slug, blocker.promotionId);
      await this.blockerRepo.delete({ id: blockerId });
   }

   // ── approval workflows ───────────────────────────────────────────────────

   public async upsertWorkflow(slug: string, stageId: number, input: WorkflowInput): Promise<ApprovalWorkflow> {
      const stage = await this.requireStage(slug, stageId);
      let workflow = await this.workflowRepo.findOneBy({ stageId: stage.id });
      if (!workflow) {
         if (!input.name) throw new BadRequestException("name is required when creating a workflow");
         workflow = this.workflowRepo.create({
            stageId: stage.id,
            name: input.name,
            rollbackOnFailure: input.rollbackOnFailure ?? false,
            requiresConsistentRevisions: input.requiresConsistentRevisions ?? false,
            enabled: input.enabled ?? true,
         });
      } else {
         if (input.name !== undefined) workflow.name = input.name;
         if (input.rollbackOnFailure !== undefined) workflow.rollbackOnFailure = input.rollbackOnFailure;
         if (input.requiresConsistentRevisions !== undefined) {
            workflow.requiresConsistentRevisions = input.requiresConsistentRevisions;
         }
         if (input.enabled !== undefined) workflow.enabled = input.enabled;
      }
      return this.workflowRepo.save(workflow);
   }

   public async deleteWorkflow(slug: string, stageId: number): Promise<void> {
      const stage = await this.requireStage(slug, stageId);
      const workflow = await this.workflowRepo.findOneBy({ stageId: stage.id });
      if (!workflow) return;
      await this.workflowRepo.delete({ id: workflow.id });
   }

   public async createWorkflowStep(slug: string, stageId: number, input: WorkflowStepInput): Promise<ApprovalWorkflowStep> {
      const stage = await this.requireStage(slug, stageId);
      const workflow = await this.workflowRepo.findOneBy({ stageId: stage.id });
      if (!workflow) throw new NotFoundException(`Stage "${stage.name}" has no approval workflow`);
      if (!input.name) throw new BadRequestException("name is required");

      const siblings = await this.workflowStepRepo.find({ where: { workflowId: workflow.id } });
      if (siblings.some((s) => s.name === input.name)) {
         throw new BadRequestException(`Step "${input.name}" already exists in this workflow`);
      }
      this.assertDependenciesResolvable(siblings, input.name, input.dependencies ?? []);

      const step = this.workflowStepRepo.create({
         workflowId: workflow.id,
         name: input.name,
         position: input.position ?? siblings.length,
         manual: input.manual ?? false,
         cmd: input.cmd ?? "",
         workDir: input.workDir ?? "",
         maxAttempts: input.maxAttempts ?? 1,
         timeoutMs: input.timeoutMs ?? 0,
         enabled: input.enabled ?? true,
      });
      step.setArgs(input.args ?? []);
      step.setDependencies(input.dependencies ?? []);
      return this.workflowStepRepo.save(step);
   }

   public async updateWorkflowStep(slug: string, stepId: number, input: WorkflowStepInput): Promise<ApprovalWorkflowStep> {
      const step = await this.workflowStepRepo.findOneBy({ id: stepId });
      if (!step) throw new NotFoundException(`Workflow step ${stepId} not found`);
      const workflow = await this.workflowRepo.findOneBy({ id: step.workflowId });
      if (!workflow) throw new NotFoundException(`Workflow ${step.workflowId} not found`);
      await this.requireStage(slug, workflow.stageId);

      const siblings = (await this.workflowStepRepo.find({ where: { workflowId: workflow.id } })).filter(
         (s) => s.id !== step.id,
      );
      const name = input.name ?? step.name;
      if (input.name !== undefined && siblings.some((s) => s.name === input.name)) {
         throw new BadRequestException(`Step "${input.name}" already exists in this workflow`);
      }
      if (input.dependencies !== undefined) {
         this.assertDependenciesResolvable(siblings, name, input.dependencies);
         step.setDependencies(input.dependencies);
      }

      step.name = name;
      if (input.position !== undefined) step.position = input.position;
      if (input.manual !== undefined) step.manual = input.manual;
      if (input.cmd !== undefined) step.cmd = input.cmd;
      if (input.args !== undefined) step.setArgs(input.args);
      if (input.workDir !== undefined) step.workDir = input.workDir;
      if (input.maxAttempts !== undefined) step.maxAttempts = Math.max(1, input.maxAttempts);
      if (input.timeoutMs !== undefined) step.timeoutMs = Math.max(0, input.timeoutMs);
      if (input.enabled !== undefined) step.enabled = input.enabled;
      return this.workflowStepRepo.save(step);
   }

   public async deleteWorkflowStep(slug: string, stepId: number): Promise<void> {
      const step = await this.workflowStepRepo.findOneBy({ id: stepId });
      if (!step) throw new NotFoundException(`Workflow step ${stepId} not found`);
      const workflow = await this.workflowRepo.findOneBy({ id: step.workflowId });
      if (!workflow) throw new NotFoundException(`Workflow ${step.workflowId} not found`);
      await this.requireStage(slug, workflow.stageId);

      // Drop the dependency from any sibling that referenced it, otherwise the
      // workflow would deadlock on a step that no longer exists.
      const siblings = await this.workflowStepRepo.find({ where: { workflowId: workflow.id } });
      for (const sibling of siblings) {
         const deps = sibling.getDependencies();
         if (!deps.includes(step.name)) continue;
         sibling.setDependencies(deps.filter((d) => d !== step.name));
         await this.workflowStepRepo.save(sibling);
      }
      await this.workflowStepRepo.delete({ id: stepId });
   }

   /**
    * Rejects dependencies that point at unknown steps, at the step itself, or
    * that would introduce a cycle — all of which would stall the workflow.
    */
   private assertDependenciesResolvable(
      siblings: ApprovalWorkflowStep[],
      name: string,
      dependencies: string[],
   ): void {
      const known = new Set(siblings.map((s) => s.name));
      for (const dependency of dependencies) {
         if (dependency === name) throw new BadRequestException(`Step "${name}" cannot depend on itself`);
         if (!known.has(dependency)) throw new BadRequestException(`Unknown dependency "${dependency}"`);
      }

      const graph = new Map<string, string[]>(siblings.map((s) => [s.name, s.getDependencies()]));
      graph.set(name, dependencies);

      const state = new Map<string, "visiting" | "done">();
      const visit = (node: string): void => {
         const seen = state.get(node);
         if (seen === "done") return;
         if (seen === "visiting") throw new BadRequestException(`Dependency cycle detected at "${node}"`);
         state.set(node, "visiting");
         for (const next of graph.get(node) ?? []) {
            if (graph.has(next)) visit(next);
         }
         state.set(node, "done");
      };
      visit(name);
   }
}
