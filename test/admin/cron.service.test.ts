import { CronAdminService, humanizeCron } from "src/admin/cron.service";
import { NotFoundException } from "@nestjs/common";

describe("humanizeCron", () => {
   it.each([
      ["*/30 * * * * *", "Every 30 seconds"],
      ["*/1 * * * *", "Every minute"],
      ["* * * * *", "Every minute"],
      ["*/5 * * * *", "Every 5 minutes"],
      ["0 0-23/1 * * *", "Every hour"],
      ["0 03 * * *", "Every day at 3:00 AM"],
      ["0 0 * * *", "Every day at 12:00 AM (midnight)"],
      ["0 4 * * *", "Every day at 4:00 AM"],
      ["30 14 * * *", "Every day at 2:30 PM"],
   ])("humanizes %s -> %s", (expr, expected) => {
      expect(humanizeCron(expr)).toBe(expected);
   });

   it("falls back to the raw expression for unrecognised shapes", () => {
      expect(humanizeCron("0 0 1 1 *")).toBe("0 0 1 1 *");
      expect(humanizeCron("not a cron")).toBe("not a cron");
   });
});

describe("CronAdminService", () => {
   const makeJob = (over: Partial<any> = {}) => ({
      cronTime: { source: "*/1 * * * *" },
      nextDate: () => ({ toISO: () => "2026-01-01T00:01:00.000Z" }),
      lastDate: () => null,
      isActive: true,
      fireOnTick: jest.fn().mockResolvedValue(undefined),
      ...over,
   });

   const buildService = (jobs: Map<string, any>) => {
      const registry = {
         getCronJobs: () => jobs,
         getCronJob: (name: string) => {
            const j = jobs.get(name);
            if (!j) throw new Error("not found");
            return j;
         },
      };
      return new CronAdminService(registry as any);
   };

   it("lists jobs with expression, human label, next run and running state, sorted by name", () => {
      const jobs = new Map<string, any>([
         ["b:job", makeJob()],
         ["a:job", makeJob({ cronTime: { source: "0 4 * * *" }, isActive: false })],
      ]);
      const service = buildService(jobs);

      const list = service.list();

      expect(list.map(j => j.name)).toEqual(["a:job", "b:job"]);
      expect(list[0]).toMatchObject({ expression: "0 4 * * *", human: "Every day at 4:00 AM", running: false });
      expect(list[1]).toMatchObject({ expression: "*/1 * * * *", human: "Every minute", running: true, nextRun: "2026-01-01T00:01:00.000Z" });
      expect(list[1].lastRun).toBeNull();
   });

   it("reports the scheduled lastDate as lastRun", () => {
      const last = new Date("2026-01-01T00:00:00.000Z");
      const service = buildService(new Map([["j", makeJob({ lastDate: () => last })]]));
      expect(service.list()[0].lastRun).toBe(last.toISOString());
   });

   it("fires the job and records a manual run timestamp", async () => {
      const job = makeJob({ lastDate: () => null });
      const service = buildService(new Map([["j", job]]));

      const res = await service.trigger("j");

      expect(job.fireOnTick).toHaveBeenCalledTimes(1);
      expect(res.name).toBe("j");
      // fireOnTick doesn't update cron's lastDate, so the service surfaces the manual run instead
      expect(service.list()[0].lastRun).not.toBeNull();
   });

   it("throws NotFound for an unknown job", async () => {
      const service = buildService(new Map());
      await expect(service.trigger("missing")).rejects.toBeInstanceOf(NotFoundException);
   });
});
