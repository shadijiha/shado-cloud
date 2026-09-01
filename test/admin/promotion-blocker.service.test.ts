import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PromotionBlockerService } from "src/admin/pipelines/promotion-blocker.service";
import { PipelinePromotionBlocker } from "src/models/admin/pipeline/pipelinePromotionBlocker";
import { BlockerKind, BlockerState } from "src/models/admin/pipeline/pipeline.types";

/**
 * Builds a blocker entity with the real accessors attached, so `getConfig()`
 * behaves exactly as it does at runtime.
 */
function makeBlocker(
   overrides: Omit<Partial<PipelinePromotionBlocker>, "config"> & { config?: unknown },
): PipelinePromotionBlocker {
   const blocker = new PipelinePromotionBlocker();
   blocker.id = overrides.id ?? 1;
   blocker.promotionId = 1;
   blocker.kind = overrides.kind ?? BlockerKind.TimeWindow;
   blocker.name = overrides.name ?? "blocker";
   blocker.description = null;
   blocker.state = overrides.state ?? BlockerState.Ok;
   blocker.enabled = overrides.enabled ?? true;
   blocker.lastStateChange = null;
   blocker.config = typeof overrides.config === "string" ? overrides.config : JSON.stringify(overrides.config ?? {});
   return blocker;
}

describe("PromotionBlockerService", () => {
   let service: PromotionBlockerService;
   let repo: { findOneBy: jest.Mock; save: jest.Mock };

   beforeEach(async () => {
      repo = { findOneBy: jest.fn(), save: jest.fn().mockImplementation((b) => Promise.resolve(b)) };
      const module: TestingModule = await Test.createTestingModule({
         providers: [
            PromotionBlockerService,
            { provide: getRepositoryToken(PipelinePromotionBlocker), useValue: repo },
         ],
      }).compile();
      service = module.get(PromotionBlockerService);
   });

   afterEach(() => jest.clearAllMocks());

   describe("isInsideTimeWindow", () => {
      // 2026-09-02 is a Wednesday (day 3).
      const wednesday = (hours: number, minutes = 0) => new Date(2026, 8, 2, hours, minutes, 0);

      it("is inside a same-day window and outside it before/after", () => {
         const config = { daysOfWeek: [3], startTime: "09:00", endTime: "17:00" };
         expect(service.isInsideTimeWindow(config, wednesday(8, 59))).toBe(false);
         expect(service.isInsideTimeWindow(config, wednesday(9, 0))).toBe(true);
         expect(service.isInsideTimeWindow(config, wednesday(16, 59))).toBe(true);
         // End time is exclusive.
         expect(service.isInsideTimeWindow(config, wednesday(17, 0))).toBe(false);
      });

      it("rejects days that are not listed", () => {
         const config = { daysOfWeek: [1, 2], startTime: "09:00", endTime: "17:00" };
         expect(service.isInsideTimeWindow(config, wednesday(12))).toBe(false);
      });

      it("treats an empty day list as every day", () => {
         const config = { daysOfWeek: [], startTime: "09:00", endTime: "17:00" };
         expect(service.isInsideTimeWindow(config, wednesday(12))).toBe(true);
      });

      it("handles a window that crosses midnight", () => {
         // Wednesday 22:00 → Thursday 04:00
         const config = { daysOfWeek: [3], startTime: "22:00", endTime: "04:00" };
         expect(service.isInsideTimeWindow(config, wednesday(21, 59))).toBe(false);
         expect(service.isInsideTimeWindow(config, wednesday(22, 0))).toBe(true);
         expect(service.isInsideTimeWindow(config, wednesday(23, 30))).toBe(true);
         // Thursday 02:00 belongs to the window that opened on Wednesday.
         expect(service.isInsideTimeWindow(config, new Date(2026, 8, 3, 2, 0))).toBe(true);
         // Thursday 05:00 is past the tail.
         expect(service.isInsideTimeWindow(config, new Date(2026, 8, 3, 5, 0))).toBe(false);
         // Wednesday 02:00 is NOT in it — that tail belongs to Tuesday's window.
         expect(service.isInsideTimeWindow(config, wednesday(2, 0))).toBe(false);
      });

      it("falls back to a full day when times are missing", () => {
         expect(service.isInsideTimeWindow({ daysOfWeek: [] }, wednesday(3))).toBe(true);
      });
   });

   describe("evaluate", () => {
      it("reports no blockage when there are no blockers", async () => {
         const result = await service.evaluate([]);
         expect(result.isBlocked).toBe(false);
         expect(result.reason).toBe("");
         expect(result.awaitingApproval).toBe(false);
      });

      it("ignores disabled blockers", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.ManualApproval,
            state: BlockerState.Blocking,
            enabled: false,
         });
         const result = await service.evaluate([blocker]);
         expect(result.isBlocked).toBe(false);
         expect(result.evaluations).toHaveLength(0);
      });

      it("blocks outside a time window and explains why", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.TimeWindow,
            name: "Business hours",
            config: { daysOfWeek: [1, 2, 3, 4], startTime: "09:00", endTime: "16:00" },
         });
         // Saturday — not a listed day.
         const result = await service.evaluate([blocker], new Date(2026, 8, 5, 12, 0));
         expect(result.isBlocked).toBe(true);
         expect(result.reason).toContain("Outside time window");
         // A time window resolves itself; it does not need a human.
         expect(result.awaitingApproval).toBe(false);
      });

      it("inverts a time window into a freeze period", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.TimeWindow,
            name: "Change freeze",
            config: { daysOfWeek: [3], startTime: "09:00", endTime: "17:00", invert: true },
         });
         // Inside the freeze → blocked.
         expect((await service.evaluate([blocker], new Date(2026, 8, 2, 12, 0))).isBlocked).toBe(true);
         // Outside the freeze → open.
         expect((await service.evaluate([blocker], new Date(2026, 8, 2, 20, 0))).isBlocked).toBe(false);
      });

      it("flags a manual gate as awaiting a human", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.ManualApproval,
            name: "US sign-off",
            state: BlockerState.Blocking,
            config: { prompt: "Confirm EU is healthy" },
         });
         const result = await service.evaluate([blocker]);
         expect(result.isBlocked).toBe(true);
         expect(result.awaitingApproval).toBe(true);
         expect(result.reason).toBe("Confirm EU is healthy");
         expect(result.blocking[0].needsHuman).toBe(true);
      });

      it("does not claim to be awaiting approval when an automatic blocker is also firing", async () => {
         const manual = makeBlocker({ id: 1, kind: BlockerKind.ManualApproval, state: BlockerState.Blocking });
         const alarm = makeBlocker({
            id: 2,
            kind: BlockerKind.Alarm,
            state: BlockerState.Blocking,
            config: { monitor: "availability" },
         });
         const result = await service.evaluate([manual, alarm], new Date(2026, 8, 2, 12, 0));
         expect(result.isBlocked).toBe(true);
         // A human cannot clear the alarm, so the run is BLOCKED not AWAITING_APPROVAL.
         expect(result.awaitingApproval).toBe(false);
         expect(result.blocking).toHaveLength(2);
      });

      it("treats an alarm in an unknown state as blocking", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.Alarm,
            state: BlockerState.Unknown,
            config: { monitor: "availability" },
         });
         const result = await service.evaluate([blocker]);
         expect(result.isBlocked).toBe(true);
         expect(result.reason).toContain("unknown state");
      });

      it("does not block on a healthy alarm", async () => {
         const blocker = makeBlocker({
            kind: BlockerKind.Alarm,
            state: BlockerState.Ok,
            config: { monitor: "availability" },
         });
         expect((await service.evaluate([blocker])).isBlocked).toBe(false);
      });

      it("tolerates malformed blocker config instead of throwing", async () => {
         const blocker = makeBlocker({ kind: BlockerKind.TimeWindow, config: "{not json" });
         await expect(service.evaluate([blocker])).resolves.toBeDefined();
      });
   });

   describe("release / rearm", () => {
      it("clears a manual gate and stamps the transition", async () => {
         const blocker = makeBlocker({ kind: BlockerKind.ManualApproval, state: BlockerState.Blocking });
         repo.findOneBy.mockResolvedValue(blocker);

         const released = await service.release(blocker.id, "admin#1");
         expect(released.state).toBe(BlockerState.Ok);
         expect(released.lastStateChange).toBeInstanceOf(Date);
         expect(repo.save).toHaveBeenCalledWith(blocker);
      });

      it("re-arms a manual gate so the next run stops again", async () => {
         const blocker = makeBlocker({ kind: BlockerKind.ManualApproval, state: BlockerState.Ok });
         repo.findOneBy.mockResolvedValue(blocker);

         await service.rearm(blocker.id);
         expect(blocker.state).toBe(BlockerState.Blocking);
      });

      it("never re-arms an automatic blocker", async () => {
         const blocker = makeBlocker({ kind: BlockerKind.Alarm, state: BlockerState.Ok });
         repo.findOneBy.mockResolvedValue(blocker);

         await service.rearm(blocker.id);
         expect(blocker.state).toBe(BlockerState.Ok);
         expect(repo.save).not.toHaveBeenCalled();
      });
   });
});
