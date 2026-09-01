import { ReplicaDeploymentExecutor, type DeployReporter } from "src/replication/replica-deployment.executor";
import type { ReplicaDeployStatus } from "src/replication/replica-link.constants";

/** Records everything the executor reports, so assertions read like a transcript. */
function recordingReporter() {
   const output: { step: string; chunk: string }[] = [];
   const steps: { step: string; status: ReplicaDeployStatus; error?: string }[] = [];
   const reporter: DeployReporter = {
      output: (step, chunk) => output.push({ step, chunk }),
      step: (step, status, detail) => steps.push({ step, status, error: detail?.error }),
   };
   return { reporter, output, steps };
}

function makeExecutor(tasks: unknown, runner: Partial<Record<string, unknown>> = {}) {
   const config = {
      get: (key: string) => (key === "this-service.replication.deploy-tasks" ? tasks : undefined),
   };
   const baseRunner = {
      resolveWorkDir: (...candidates: (string | undefined)[]) => candidates.find(Boolean) ?? "/cwd",
      run: jest.fn().mockResolvedValue({ exitCode: 0 }),
      spawnDetached: jest.fn(),
      cancelAll: jest.fn(),
      ...runner,
   };
   const executor = new ReplicaDeploymentExecutor(config as never, baseRunner as never);
   return { executor, runner: baseRunner };
}

const TASK = {
   name: "redeploy",
   "work-dir": "/srv/app",
   steps: [
      { name: "git pull", cmd: "git", args: ["pull"] },
      { name: "build", cmd: "npm", args: ["run", "build"] },
   ],
};

describe("ReplicaDeploymentExecutor.accept", () => {
   it("rejects a task this replica does not declare, naming what it does declare", () => {
      const { executor } = makeExecutor([TASK]);
      const ack = executor.accept({ deploymentId: "d1", task: "something-else" });
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toContain("Unknown deploy task");
      expect(ack.reason).toContain("redeploy");
   });

   it("rejects everything when no tasks are declared — the safe default on upgrade", () => {
      const { executor } = makeExecutor(undefined);
      const ack = executor.accept({ deploymentId: "d1", task: "redeploy" });
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toContain("declares no deploy tasks");
   });

   it("accepts a declared task and advertises its steps upfront", () => {
      const { executor } = makeExecutor([TASK]);
      const ack = executor.accept({ deploymentId: "d1", task: "redeploy" });
      expect(ack.accepted).toBe(true);
      expect(ack.steps).toEqual(["git pull", "build"]);
   });

   it("rejects a malformed request", () => {
      const { executor } = makeExecutor([TASK]);
      expect(executor.accept({ deploymentId: "", task: "" }).accepted).toBe(false);
   });

   it("rejects a task with no steps", () => {
      const { executor } = makeExecutor([{ name: "empty", steps: [] }]);
      expect(executor.accept({ deploymentId: "d1", task: "empty" }).accepted).toBe(false);
   });

   it("refuses a second deployment while one is running", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { executor } = makeExecutor([TASK], {
         run: jest.fn().mockImplementation(() => gate.then(() => ({ exitCode: 0 }))),
      });

      const { reporter } = recordingReporter();
      const inFlight = executor.run({ deploymentId: "d1", task: "redeploy" }, reporter);

      // Give the first step a tick to start before probing.
      await Promise.resolve();
      const ack = executor.accept({ deploymentId: "d2", task: "redeploy" });
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toContain("Already running");

      release();
      await inFlight;

      // Once finished, the next request is accepted again.
      expect(executor.accept({ deploymentId: "d3", task: "redeploy" }).accepted).toBe(true);
   });
});

describe("ReplicaDeploymentExecutor.run", () => {
   it("runs every step in order and reports success", async () => {
      const { executor, runner } = makeExecutor([TASK]);
      const { reporter, steps } = recordingReporter();

      const result = await executor.run({ deploymentId: "d1", task: "redeploy" }, reporter);

      expect(result.status).toBe("success");
      expect(result.steps.map((s) => s.name)).toEqual(["git pull", "build"]);
      expect(result.steps.every((s) => s.status === "success")).toBe(true);
      expect(steps).toEqual([
         { step: "git pull", status: "running", error: undefined },
         { step: "git pull", status: "success", error: undefined },
         { step: "build", status: "running", error: undefined },
         { step: "build", status: "success", error: undefined },
      ]);
      expect((runner.run as jest.Mock).mock.calls[0][1]).toMatchObject({ cmd: "git", args: ["pull"], cwd: "/srv/app" });
   });

   it("stops at the first failing step and reports which one failed", async () => {
      const { executor, runner } = makeExecutor([TASK], {
         run: jest
            .fn()
            .mockResolvedValueOnce({ exitCode: 0 })
            .mockRejectedValueOnce(new Error("Process exited with code 1")),
      });
      const { reporter } = recordingReporter();

      const result = await executor.run({ deploymentId: "d1", task: "redeploy" }, reporter);

      expect(result.status).toBe("failed");
      expect(result.error).toContain('Step "build" failed');
      expect(result.steps.map((s) => s.status)).toEqual(["success", "failed"]);
      // The second step failed, so a third call never happened.
      expect((runner.run as jest.Mock)).toHaveBeenCalledTimes(2);
   });

   it("streams command output through the reporter", async () => {
      const { executor } = makeExecutor([{ name: "t", steps: [{ name: "one", cmd: "echo" }] }], {
         run: jest.fn().mockImplementation(async (_h: string, opts: { onOutput: (c: string) => void }) => {
            opts.onOutput("hello\n");
            opts.onOutput("world\n");
            return { exitCode: 0 };
         }),
      });
      const { reporter, output } = recordingReporter();

      await executor.run({ deploymentId: "d1", task: "t" }, reporter);

      expect(output.map((o) => o.chunk).join("")).toBe("hello\nworld\n");
      expect(output.every((o) => o.step === "one")).toBe(true);
   });

   it("reports the result BEFORE firing a restart step, and flags it", async () => {
      const calls: string[] = [];
      const { executor, runner } = makeExecutor(
         [{ name: "t", steps: [{ name: "restart", cmd: "pm2", args: ["restart", "x"], "triggers-restart": true }] }],
         { spawnDetached: jest.fn(() => calls.push("spawned")) },
      );
      const { reporter } = recordingReporter();

      const result = await executor.run({ deploymentId: "d1", task: "t" }, reporter);

      // Marked successful and flagged so the master does not read the ensuing
      // disconnect as a failure.
      expect(result.status).toBe("success");
      expect(result.restarting).toBe(true);
      expect(result.steps).toEqual([expect.objectContaining({ name: "restart", status: "success" })]);
      expect(runner.spawnDetached).toHaveBeenCalledWith("pm2", ["restart", "x"], "/cwd");
      // The command never went through the normal (awaited) runner.
      expect(runner.run).not.toHaveBeenCalled();
   });

   it("honours a per-step work-dir override", async () => {
      const { executor, runner } = makeExecutor([
         { name: "t", "work-dir": "/task", steps: [{ name: "one", cmd: "ls", "work-dir": "/step" }] },
      ]);
      const { reporter } = recordingReporter();

      await executor.run({ deploymentId: "d1", task: "t" }, reporter);

      expect((runner.run as jest.Mock).mock.calls[0][1]).toMatchObject({ cwd: "/step" });
   });

   it("returns a failed result rather than throwing for an unknown task", async () => {
      const { executor } = makeExecutor([TASK]);
      const { reporter } = recordingReporter();
      const result = await executor.run({ deploymentId: "d1", task: "nope" }, reporter);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Unknown deploy task");
   });

   it("stops mid-task when cancelled", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { executor } = makeExecutor([TASK], {
         run: jest.fn().mockImplementationOnce(() => gate.then(() => ({ exitCode: 0 }))),
      });
      const { reporter } = recordingReporter();

      const inFlight = executor.run({ deploymentId: "d1", task: "redeploy" }, reporter);
      await Promise.resolve();
      expect(executor.cancel("d1")).toBe(true);
      release();

      const result = await inFlight;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Cancelled");
      // The second step was skipped rather than run.
      expect(result.steps.some((s) => s.name === "build" && s.status === "skipped")).toBe(true);
   });

   it("ignores a cancel for a different deployment", async () => {
      const { executor } = makeExecutor([TASK]);
      expect(executor.cancel("not-running")).toBe(false);
   });

   it("lists the tasks it is willing to run", () => {
      const { executor } = makeExecutor([TASK, { name: "other", steps: [{ name: "x", cmd: "true" }] }]);
      expect(executor.availableTasks()).toEqual(["redeploy", "other"]);
   });
});
