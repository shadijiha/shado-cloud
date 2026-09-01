import {
   ReplicaDeploymentCoordinator,
   type ReplicaDeploymentProgress,
} from "src/replication/replica-deployment.coordinator";
import { REPLICA_DEPLOY_EVENT } from "src/replication/replica-link.constants";

/**
 * A fake replica socket. `emit` on the deploy event invokes the ack according to
 * `behaviour`, mimicking Socket.IO's `socket.timeout(ms).emit(ev, payload, cb)`.
 */
function fakeReplica(
   ip: string,
   deviceName: string,
   behaviour: { ack: "accept" | "reject" | "timeout"; steps?: string[]; reason?: string },
) {
   const emitted: { event: string; payload: unknown }[] = [];
   const socket = {
      emit(event: string, payload: unknown, cb?: (err: Error | null, ack?: unknown) => void) {
         emitted.push({ event, payload });
         if (event !== REPLICA_DEPLOY_EVENT || !cb) return;
         // Async, like a real ack.
         setImmediate(() => {
            if (behaviour.ack === "timeout") return cb(new Error("operation has timed out"));
            if (behaviour.ack === "reject") return cb(null, { accepted: false, reason: behaviour.reason ?? "nope" });
            cb(null, { accepted: true, steps: behaviour.steps ?? ["step-one"] });
         });
      },
      timeout() {
         return socket;
      },
   };
   return { socketId: `sock-${deviceName}`, socket, ip, deviceName, mirrorDirs: 0, emitted };
}

function makeCoordinator(replicas: ReturnType<typeof fakeReplica>[]) {
   let disconnectListener: ((identity: { ip: string; deviceName: string }, socketId: string) => void) | undefined;
   const registry = {
      connected: () => replicas,
      connectedCount: () => replicas.length,
      socketFor: (identity: { ip: string; deviceName: string }) =>
         replicas.find((r) => r.ip === identity.ip && r.deviceName === identity.deviceName)?.socket,
      onDisconnect: (listener: typeof disconnectListener) => {
         disconnectListener = listener;
         return () => {};
      },
   };
   const coordinator = new ReplicaDeploymentCoordinator(registry as never);
   coordinator.onModuleInit();
   return { coordinator, disconnect: (ip: string, deviceName: string) => disconnectListener?.({ ip, deviceName }, "s") };
}

describe("ReplicaDeploymentCoordinator", () => {
   it("succeeds trivially when no replicas are connected", async () => {
      const { coordinator } = makeCoordinator([]);
      const summary = await coordinator.deploy("redeploy");

      // Replicas are mirrors; an offline one must not block the primary's release.
      expect(summary.ok).toBe(true);
      expect(summary.attempted).toBe(0);
      expect(summary.reports).toEqual([]);
   });

   it("fans out to every connected replica and aggregates success", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
      const b = fakeReplica("10.0.0.2", "beta", { ack: "accept" });
      const { coordinator } = makeCoordinator([a, b]);

      const promise = coordinator.deploy("redeploy", { revision: "v3.0.90" });

      // Both accept, then both report success.
      await new Promise((r) => setImmediate(r));
      coordinator.handleResult({ ip: "10.0.0.1", deviceName: "alpha" }, {
         deploymentId: deploymentIdFrom(a), status: "success", steps: [{ name: "step-one", status: "success", durationMs: 5 }], durationMs: 5,
      });
      coordinator.handleResult({ ip: "10.0.0.2", deviceName: "beta" }, {
         deploymentId: deploymentIdFrom(b), status: "success", steps: [{ name: "step-one", status: "success", durationMs: 7 }], durationMs: 7,
      });

      const summary = await promise;
      expect(summary.attempted).toBe(2);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.ok).toBe(true);
      // The revision travelled with the request.
      expect((a.emitted[0].payload as { revision: string }).revision).toBe("v3.0.90");
   });

   it("fails the fan-out when one replica reports failure", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
      const b = fakeReplica("10.0.0.2", "beta", { ack: "accept" });
      const { coordinator } = makeCoordinator([a, b]);

      const promise = coordinator.deploy("redeploy");
      await new Promise((r) => setImmediate(r));
      coordinator.handleResult({ ip: "10.0.0.1", deviceName: "alpha" }, {
         deploymentId: deploymentIdFrom(a), status: "success", steps: [], durationMs: 1,
      });
      coordinator.handleResult({ ip: "10.0.0.2", deviceName: "beta" }, {
         deploymentId: deploymentIdFrom(b), status: "failed", error: "build blew up", steps: [], durationMs: 2,
      });

      const summary = await promise;
      expect(summary.ok).toBe(false);
      expect(summary.failed).toBe(1);
      expect(summary.reports.find((r) => r.deviceName === "beta")).toMatchObject({
         state: "failed",
         reason: "build blew up",
      });
   });

   it("treats a rejection as configuration, not failure", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "reject", reason: "task not declared here" });
      const { coordinator } = makeCoordinator([a]);

      const summary = await coordinator.deploy("redeploy");

      // Reported, but the fan-out is still ok: the replica simply does not run that task.
      expect(summary.reports[0]).toMatchObject({ state: "rejected", reason: "task not declared here" });
      expect(summary.ok).toBe(true);
      expect(summary.failed).toBe(0);
      expect(summary.succeeded).toBe(0);
   });

   it("settles a replica that never acknowledges", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "timeout" });
      const { coordinator } = makeCoordinator([a]);

      const summary = await coordinator.deploy("redeploy");

      expect(summary.reports[0].state).toBe("timed_out");
      expect(summary.ok).toBe(false);
   });

   it("settles immediately when a replica disconnects mid-deploy", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
      const { coordinator, disconnect } = makeCoordinator([a]);

      // A 10-minute timeout would hang the test if the disconnect path did not work.
      const promise = coordinator.deploy("redeploy", { timeoutMs: 600_000 });
      await new Promise((r) => setImmediate(r));
      disconnect("10.0.0.1", "alpha");

      const summary = await promise;
      expect(summary.reports[0]).toMatchObject({ state: "disconnected" });
      expect(summary.ok).toBe(false);
   });

   it("does NOT fail a replica that disconnects after reporting a pending restart", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
      const { coordinator, disconnect } = makeCoordinator([a]);

      const promise = coordinator.deploy("redeploy", { timeoutMs: 600_000 });
      await new Promise((r) => setImmediate(r));
      coordinator.handleResult({ ip: "10.0.0.1", deviceName: "alpha" }, {
         deploymentId: deploymentIdFrom(a), status: "success", steps: [], durationMs: 3, restarting: true,
      });
      // The replica now restarts, which drops the socket. That is expected.
      disconnect("10.0.0.1", "alpha");

      const summary = await promise;
      expect(summary.reports[0]).toMatchObject({ state: "success", restarting: true });
      expect(summary.ok).toBe(true);
   });

   it("honours the per-replica timeout after acceptance", async () => {
      jest.useFakeTimers();
      try {
         const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
         const { coordinator } = makeCoordinator([a]);

         const promise = coordinator.deploy("redeploy", { timeoutMs: 1000 });
         // Let the ack land, then run out the clock.
         await Promise.resolve();
         jest.advanceTimersByTime(0);
         await Promise.resolve();
         jest.advanceTimersByTime(1500);

         const summary = await promise;
         expect(summary.reports[0].state).toBe("timed_out");
         expect(summary.reports[0].reason).toContain("No result within");
      } finally {
         jest.useRealTimers();
      }
   });

   it("streams output and step transitions through onProgress, and retains output", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept", steps: ["build"] });
      const { coordinator } = makeCoordinator([a]);
      const events: ReplicaDeploymentProgress[] = [];

      const promise = coordinator.deploy("redeploy", { onProgress: (e) => events.push(e) });
      await new Promise((r) => setImmediate(r));

      const id = deploymentIdFrom(a);
      const replica = { ip: "10.0.0.1", deviceName: "alpha" };
      coordinator.handleOutput(replica, { deploymentId: id, step: "build", chunk: "compiling…\n", seq: 1 });
      coordinator.handleStep(replica, { deploymentId: id, step: "build", status: "success" });
      coordinator.handleResult(replica, { deploymentId: id, status: "success", steps: [], durationMs: 1 });

      const summary = await promise;

      expect(events.map((e) => e.type)).toEqual(["accepted", "output", "step", "settled"]);
      // The per-replica breakdown keeps the console output, which is the point.
      expect(summary.reports[0].steps).toEqual([
         expect.objectContaining({ name: "build", status: "success", output: "compiling…\n" }),
      ]);
   });

   it("seeds the advertised steps so the plan is visible before any output", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept", steps: ["one", "two", "three"] });
      const { coordinator } = makeCoordinator([a]);

      const promise = coordinator.deploy("redeploy");
      await new Promise((r) => setImmediate(r));
      coordinator.handleResult({ ip: "10.0.0.1", deviceName: "alpha" }, {
         deploymentId: deploymentIdFrom(a), status: "success", steps: [], durationMs: 1,
      });

      const summary = await promise;
      expect(summary.reports[0].steps.map((s) => s.name)).toEqual(["one", "two", "three"]);
   });

   it("ignores late events for an already-settled replica", async () => {
      const a = fakeReplica("10.0.0.1", "alpha", { ack: "accept" });
      const { coordinator } = makeCoordinator([a]);

      const promise = coordinator.deploy("redeploy");
      await new Promise((r) => setImmediate(r));
      const id = deploymentIdFrom(a);
      const replica = { ip: "10.0.0.1", deviceName: "alpha" };
      coordinator.handleResult(replica, { deploymentId: id, status: "success", steps: [], durationMs: 1 });
      await promise;

      // Arriving after the fan-out finished: must not throw or resurrect anything.
      expect(() =>
         coordinator.handleOutput(replica, { deploymentId: id, step: "x", chunk: "late\n", seq: 99 }),
      ).not.toThrow();
   });

   it("ignores events for an unknown deployment id", async () => {
      const { coordinator } = makeCoordinator([]);
      expect(() =>
         coordinator.handleResult({ ip: "1.1.1.1", deviceName: "ghost" }, {
            deploymentId: "does-not-exist", status: "success", steps: [], durationMs: 0,
         }),
      ).not.toThrow();
   });
});

/** Reads the deploymentId the coordinator generated, off the emitted request. */
function deploymentIdFrom(replica: ReturnType<typeof fakeReplica>): string {
   const request = replica.emitted.find((e) => e.event === REPLICA_DEPLOY_EVENT)?.payload as { deploymentId: string };
   return request.deploymentId;
}
