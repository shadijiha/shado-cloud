import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PipelineConfigService } from "src/admin/pipelines/pipeline-config.service";
import { Pipeline } from "src/models/admin/pipeline/pipeline";
import { PipelineWave } from "src/models/admin/pipeline/pipelineWave";
import { PipelineStage } from "src/models/admin/pipeline/pipelineStage";
import { PipelineTarget } from "src/models/admin/pipeline/pipelineTarget";
import { PipelinePromotion } from "src/models/admin/pipeline/pipelinePromotion";
import { PipelinePromotionBlocker } from "src/models/admin/pipeline/pipelinePromotionBlocker";
import { ApprovalWorkflow } from "src/models/admin/pipeline/approvalWorkflow";
import { ApprovalWorkflowStep } from "src/models/admin/pipeline/approvalWorkflowStep";
import { PromotionState } from "src/models/admin/pipeline/pipeline.types";

/**
 * Minimal in-memory stand-in for the repository methods the service touches.
 *
 * `create` returns a real entity instance when a constructor is supplied, because
 * the service relies on the entities' `setArgs` / `setDependencies` accessors.
 */
function mockRepo(
   overrides: Record<string, jest.Mock> = {},
   Entity?: new () => object,
) {
   return {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findOneBy: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      create: jest
         .fn()
         .mockImplementation((entity) => (Entity ? Object.assign(new Entity(), entity) : entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      ...overrides,
   };
}

function makeStep(name: string, dependencies: string[] = [], id = 1): ApprovalWorkflowStep {
   const step = new ApprovalWorkflowStep();
   step.id = id;
   step.workflowId = 10;
   step.name = name;
   step.setDependencies(dependencies);
   step.setArgs([]);
   step.enabled = true;
   return step;
}

describe("PipelineConfigService", () => {
   let service: PipelineConfigService;
   let repos: Record<string, ReturnType<typeof mockRepo>>;

   const pipeline = Object.assign(new Pipeline(), { id: 1, slug: "svc", name: "Service" });
   const stage = Object.assign(new PipelineStage(), { id: 5, pipelineId: 1, name: "Beta" });
   const workflow = Object.assign(new ApprovalWorkflow(), { id: 10, stageId: 5, name: "Beta Approval" });

   beforeEach(async () => {
      repos = {
         pipeline: mockRepo({ findOneBy: jest.fn().mockResolvedValue(pipeline) }, Pipeline),
         wave: mockRepo({}, PipelineWave),
         stage: mockRepo({ findOneBy: jest.fn().mockResolvedValue(stage) }, PipelineStage),
         target: mockRepo({}, PipelineTarget),
         promotion: mockRepo({}, PipelinePromotion),
         blocker: mockRepo({}, PipelinePromotionBlocker),
         workflow: mockRepo({ findOneBy: jest.fn().mockResolvedValue(workflow) }, ApprovalWorkflow),
         workflowStep: mockRepo({}, ApprovalWorkflowStep),
      };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            PipelineConfigService,
            { provide: getRepositoryToken(Pipeline), useValue: repos.pipeline },
            { provide: getRepositoryToken(PipelineWave), useValue: repos.wave },
            { provide: getRepositoryToken(PipelineStage), useValue: repos.stage },
            { provide: getRepositoryToken(PipelineTarget), useValue: repos.target },
            { provide: getRepositoryToken(PipelinePromotion), useValue: repos.promotion },
            { provide: getRepositoryToken(PipelinePromotionBlocker), useValue: repos.blocker },
            { provide: getRepositoryToken(ApprovalWorkflow), useValue: repos.workflow },
            { provide: getRepositoryToken(ApprovalWorkflowStep), useValue: repos.workflowStep },
         ],
      }).compile();

      service = module.get(PipelineConfigService);
   });

   afterEach(() => jest.clearAllMocks());

   describe("createPipeline", () => {
      it("rejects a slug that is not url safe", async () => {
         repos.pipeline.findOneBy.mockResolvedValue(null);
         await expect(service.createPipeline({ slug: "Not Valid", name: "x" })).rejects.toThrow(BadRequestException);
      });

      it("rejects a duplicate slug", async () => {
         await expect(service.createPipeline({ slug: "svc", name: "x" })).rejects.toThrow(/already exists/);
      });

      it("creates with sensible defaults", async () => {
         repos.pipeline.findOneBy.mockResolvedValue(null);
         await service.createPipeline({ slug: "new-svc", name: "New" });
         expect(repos.pipeline.create).toHaveBeenCalledWith(
            expect.objectContaining({ slug: "new-svc", branch: "master", enabled: true, disabled: false }),
         );
      });
   });

   describe("workflow step dependencies", () => {
      it("rejects a self dependency", async () => {
         repos.workflowStep.find.mockResolvedValue([]);
         await expect(
            service.createWorkflowStep("svc", 5, { name: "Smoke", dependencies: ["Smoke"] }),
         ).rejects.toThrow(/cannot depend on itself/);
      });

      it("rejects a dependency on a step that does not exist", async () => {
         repos.workflowStep.find.mockResolvedValue([makeStep("Smoke", [], 1)]);
         await expect(
            service.createWorkflowStep("svc", 5, { name: "Canary", dependencies: ["Nope"] }),
         ).rejects.toThrow(/Unknown dependency "Nope"/);
      });

      it("rejects a duplicate step name", async () => {
         repos.workflowStep.find.mockResolvedValue([makeStep("Smoke", [], 1)]);
         await expect(service.createWorkflowStep("svc", 5, { name: "Smoke" })).rejects.toThrow(/already exists/);
      });

      it("accepts a valid dependency chain", async () => {
         repos.workflowStep.find.mockResolvedValue([makeStep("Smoke", [], 1), makeStep("Canary", ["Smoke"], 2)]);
         const created = await service.createWorkflowStep("svc", 5, {
            name: "Sign-off",
            manual: true,
            dependencies: ["Canary"],
         });
         expect(created.getDependencies()).toEqual(["Canary"]);
         expect(created.manual).toBe(true);
      });

      it("detects a cycle introduced by an update", async () => {
         // Existing: A → B → C. Making A depend on C closes the loop.
         const a = makeStep("A", [], 1);
         const b = makeStep("B", ["A"], 2);
         const c = makeStep("C", ["B"], 3);
         repos.workflowStep.findOneBy.mockResolvedValue(a);
         repos.workflowStep.find.mockResolvedValue([a, b, c]);

         await expect(service.updateWorkflowStep("svc", 1, { dependencies: ["C"] })).rejects.toThrow(
            /Dependency cycle detected/,
         );
      });

      it("removes a deleted step from its dependents so the workflow cannot deadlock", async () => {
         const smoke = makeStep("Smoke", [], 1);
         const canary = makeStep("Canary", ["Smoke"], 2);
         repos.workflowStep.findOneBy.mockResolvedValue(smoke);
         repos.workflowStep.find.mockResolvedValue([smoke, canary]);

         await service.deleteWorkflowStep("svc", 1);

         expect(canary.getDependencies()).toEqual([]);
         expect(repos.workflowStep.save).toHaveBeenCalledWith(canary);
         expect(repos.workflowStep.delete).toHaveBeenCalledWith({ id: 1 });
      });
   });

   describe("promotions", () => {
      it("refuses a second incoming promotion for the same stage", async () => {
         repos.promotion.findOne.mockResolvedValue(Object.assign(new PipelinePromotion(), { id: 2 }));
         await expect(service.createPromotion("svc", { destStageId: 5 })).rejects.toThrow(
            /already has an incoming promotion/,
         );
      });

      it("refuses a self-referencing promotion", async () => {
         await expect(service.createPromotion("svc", { destStageId: 5, sourceStageId: 5 })).rejects.toThrow(
            /cannot start and end at the same stage/,
         );
      });

      it("records who disabled a promotion and clears it again on re-enable", async () => {
         const promotion = Object.assign(new PipelinePromotion(), {
            id: 7,
            pipelineId: 1,
            destStageId: 5,
            blockers: [],
         });
         repos.promotion.findOne.mockResolvedValue(promotion);

         await service.setPromotionState("svc", 7, PromotionState.Disabled, "admin#1", "outage");
         expect(promotion.disabledBy).toBe("admin#1");
         expect(promotion.disabledMessage).toBe("outage");
         expect(promotion.disabledAt).toBeInstanceOf(Date);

         await service.setPromotionState("svc", 7, PromotionState.On, "admin#1");
         expect(promotion.disabledBy).toBeNull();
         expect(promotion.disabledMessage).toBeNull();
         expect(promotion.disabledAt).toBeNull();
      });

      it("refuses to arm a bypass when there is nothing to bypass", async () => {
         repos.promotion.findOne.mockResolvedValue(
            Object.assign(new PipelinePromotion(), { id: 7, pipelineId: 1, blockers: [] }),
         );
         await expect(service.armBypass("svc", 7, "admin#1")).rejects.toThrow(/no blockers to bypass/);
      });
   });

   describe("stage graph integrity", () => {
      it("re-wires the graph when a middle stage is deleted", async () => {
         // A → stage(5) → B should become A → B.
         const incoming = Object.assign(new PipelinePromotion(), { id: 20, sourceStageId: 3, destStageId: 5 });
         const outgoing = Object.assign(new PipelinePromotion(), { id: 21, sourceStageId: 5, destStageId: 8 });
         repos.promotion.findOne.mockResolvedValue(incoming);
         repos.promotion.find.mockResolvedValue([outgoing]);
         repos.stage.find.mockResolvedValue([]);

         await service.deleteStage("svc", 5);

         expect(outgoing.sourceStageId).toBe(3);
         expect(repos.promotion.delete).toHaveBeenCalledWith({ id: 20 });
         expect(repos.stage.delete).toHaveBeenCalledWith({ id: 5 });
      });

      it("rejects a reorder that does not cover every stage", async () => {
         repos.stage.find.mockResolvedValue([
            Object.assign(new PipelineStage(), { id: 5, pipelineId: 1 }),
            Object.assign(new PipelineStage(), { id: 6, pipelineId: 1 }),
         ]);
         await expect(service.reorderStages("svc", [5])).rejects.toThrow(/Expected 2 stage ids/);
      });

      it("rejects a reorder containing a foreign stage id", async () => {
         repos.stage.find.mockResolvedValue([Object.assign(new PipelineStage(), { id: 5, pipelineId: 1 })]);
         await expect(service.reorderStages("svc", [999])).rejects.toThrow(/is not part of/);
      });

      it("writes the new positions in order", async () => {
         repos.stage.find.mockResolvedValue([
            Object.assign(new PipelineStage(), { id: 5, pipelineId: 1 }),
            Object.assign(new PipelineStage(), { id: 6, pipelineId: 1 }),
         ]);
         await service.reorderStages("svc", [6, 5]);
         expect(repos.stage.update).toHaveBeenCalledWith({ id: 6 }, { position: 0 });
         expect(repos.stage.update).toHaveBeenCalledWith({ id: 5 }, { position: 1 });
      });

      it("keeps stages when their wave is deleted", async () => {
         const wave = Object.assign(new PipelineWave(), { id: 3, pipelineId: 1 });
         repos.wave.findOneBy.mockResolvedValue(wave);

         await service.deleteWave("svc", 3);

         expect(repos.stage.update).toHaveBeenCalledWith({ waveId: 3 }, { waveId: null });
         expect(repos.wave.delete).toHaveBeenCalledWith({ id: 3 });
      });
   });

   describe("cross-pipeline isolation", () => {
      it("refuses to touch a stage that belongs to another pipeline", async () => {
         repos.stage.findOneBy.mockResolvedValue(
            Object.assign(new PipelineStage(), { id: 99, pipelineId: 2, name: "Other" }),
         );
         await expect(service.updateStage("svc", 99, { name: "hijack" })).rejects.toThrow(NotFoundException);
      });

      it("refuses to touch a target whose stage belongs to another pipeline", async () => {
         repos.target.findOneBy.mockResolvedValue(
            Object.assign(new PipelineTarget(), { id: 42, stageId: 99 }),
         );
         repos.stage.findOneBy.mockResolvedValue(
            Object.assign(new PipelineStage(), { id: 99, pipelineId: 2 }),
         );
         await expect(service.deleteTarget("svc", 42)).rejects.toThrow(NotFoundException);
      });
   });

   describe("targets", () => {
      it("rejects a duplicate target name within a stage", async () => {
         repos.target.find.mockResolvedValue([Object.assign(new PipelineTarget(), { id: 1, name: "build" })]);
         await expect(service.createTarget("svc", 5, { name: "build" })).rejects.toThrow(/already exists/);
      });

      it("serialises args and clamps maxAttempts to at least one", async () => {
         repos.target.find.mockResolvedValue([]);
         const created = await service.createTarget("svc", 5, {
            name: "build",
            cmd: "npm",
            args: ["run", "build"],
            maxAttempts: 3,
         });
         expect(created.getArgs()).toEqual(["run", "build"]);

         repos.target.findOneBy.mockResolvedValue(created);
         repos.stage.findOneBy.mockResolvedValue(stage);
         const updated = await service.updateTarget("svc", created.id, { maxAttempts: 0 });
         expect(updated.maxAttempts).toBe(1);
      });
   });
});
