import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
   REPLICA_DEPLOY_CANCEL_EVENT,
   REPLICA_DEPLOY_EVENT,
   type ReplicaDeployAck,
   type ReplicaDeployOutput,
   type ReplicaDeployRequest,
   type ReplicaDeployResult,
   type ReplicaDeployStatus,
   type ReplicaDeployStepUpdate,
} from "./replica-link.constants";
import { ReplicaLinkRegistry, replicaKey, type ReplicaIdentity } from "./replica-link.registry";

/** Terminal + in-flight state of one replica within a fan-out. */
export type ReplicaDeploymentState = "rejected" | "running" | "success" | "failed" | "timed_out" | "disconnected";

export interface ReplicaStepReport {
   name: string;
   status: ReplicaDeployStatus;
   error?: string;
   output: string;
}

/** What happened on a single replica. */
export interface ReplicaDeploymentReport {
   ip: string;
   deviceName: string;
   state: ReplicaDeploymentState;
   /** Why it is not running / why it failed. */
   reason?: string;
   steps: ReplicaStepReport[];
   durationMs: number;
   /** Set when the replica ended early because a step restarts its own process. */
   restarting?: boolean;
}

export interface ReplicaDeploymentSummary {
   deploymentId: string;
   task: string;
   /** Every replica that was connected when the fan-out started. */
   reports: ReplicaDeploymentReport[];
   /** True when no replica ended in a failed/timed-out/disconnected state. */
   ok: boolean;
   /** How many replicas were connected at fan-out time. */
   attempted: number;
   succeeded: number;
   failed: number;
}

export interface ReplicaDeploymentOptions {
   revision?: string;
   commitSha?: string;
   /**
    * How long to wait for a replica's terminal report after it accepted.
    * Generous by default: a replica deploy runs npm install and a build.
    */
   timeoutMs?: number;
   /** Called as output and step transitions arrive, for live streaming to the UI. */
   onProgress?: (event: ReplicaDeploymentProgress) => void;
}

export type ReplicaDeploymentProgress =
   | { type: "accepted"; replica: ReplicaIdentity; steps: string[] }
   | { type: "rejected"; replica: ReplicaIdentity; reason: string }
   | { type: "output"; replica: ReplicaIdentity; step: string; chunk: string }
   | { type: "step"; replica: ReplicaIdentity; step: string; status: ReplicaDeployStatus; error?: string }
   | { type: "settled"; replica: ReplicaIdentity; state: ReplicaDeploymentState; reason?: string };

/** Per-replica tracking inside an in-flight fan-out. */
interface TrackedReplica {
   identity: ReplicaIdentity;
   state: ReplicaDeploymentState;
   reason?: string;
   steps: Map<string, ReplicaStepReport>;
   stepOrder: string[];
   startedAt: number;
   settledAt?: number;
   restarting?: boolean;
   timer?: ReturnType<typeof setTimeout>;
   settle: () => void;
}

interface InFlightDeployment {
   deploymentId: string;
   task: string;
   replicas: Map<string, TrackedReplica>;
   options: ReplicaDeploymentOptions;
}

/** 20 minutes: a replica deploy typically runs an install plus a build. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Cap retained output per step so one runaway build cannot exhaust master memory. */
const MAX_STEP_OUTPUT = 128 * 1024;

/**
 * Master-side coordinator for propagating a deployment to replicas.
 *
 * Sits in the replication layer, not the pipeline layer, because it owns transport
 * concerns: fan-out, correlation by `deploymentId`, per-replica timeouts, and
 * treating a dropped socket as a terminal outcome. The pipeline engine consumes it
 * as a single promise plus a progress callback and knows nothing about sockets.
 *
 * Registered globally alongside {@link ReplicaLinkRegistry}, so it exists only on a
 * master boot — the pipeline engine injects it optionally for that reason.
 */
@Injectable()
export class ReplicaDeploymentCoordinator implements OnModuleInit {
   private readonly logger = new Logger(ReplicaDeploymentCoordinator.name);
   private readonly inFlight = new Map<string, InFlightDeployment>();
   private sequence = 0;

   constructor(private readonly registry: ReplicaLinkRegistry) {}

   onModuleInit(): void {
      // A replica that drops mid-deploy can never report; settle it immediately
      // rather than waiting out the (deliberately long) deploy timeout.
      this.registry.onDisconnect((identity) => {
         for (const deployment of this.inFlight.values()) {
            const tracked = deployment.replicas.get(replicaKey(identity));
            if (!tracked || tracked.state !== "running") continue;
            // A restart-triggering step reports success *before* restarting, so the
            // ensuing disconnect is expected and must not be recorded as a failure.
            if (tracked.restarting) continue;
            this.settle(deployment, tracked, "disconnected", "Replica disconnected during deployment");
         }
      });
   }

   public connectedCount(): number {
      return this.registry.connectedCount();
   }

   /**
    * The replicas currently connected, for the UI to show what a fan-out would
    * actually reach. Without this the feature is invisible until something runs.
    */
   public describeConnected(): { ip: string; deviceName: string; mirrorDirs: number }[] {
      return this.registry.connected().map((entry) => ({
         ip: entry.ip,
         deviceName: entry.deviceName,
         mirrorDirs: entry.mirrorDirs,
      }));
   }

   /**
    * Runs `task` on every currently-connected replica and resolves once all of
    * them have reached a terminal state.
    *
    * Never rejects. Every failure mode — rejection, timeout, disconnect — is
    * reported per replica in the summary, so the caller always gets a complete
    * picture rather than an exception from the first replica to misbehave.
    */
   public async deploy(task: string, options: ReplicaDeploymentOptions = {}): Promise<ReplicaDeploymentSummary> {
      const deploymentId = `rdep_${Date.now()}_${++this.sequence}`;
      const targets = this.registry.connected();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      if (targets.length === 0) {
         this.logger.warn(`Deployment fan-out "${task}": no replicas connected`);
         return { deploymentId, task, reports: [], ok: true, attempted: 0, succeeded: 0, failed: 0 };
      }

      const deployment: InFlightDeployment = { deploymentId, task, replicas: new Map(), options };
      this.inFlight.set(deploymentId, deployment);

      this.logger.log(`Deployment fan-out ${deploymentId}: task "${task}" → ${targets.length} replica(s)`);

      try {
         await Promise.all(
            targets.map(
               (target) =>
                  new Promise<void>((resolve) => {
                     const identity: ReplicaIdentity = { ip: target.ip, deviceName: target.deviceName };
                     const tracked: TrackedReplica = {
                        identity,
                        state: "running",
                        steps: new Map(),
                        stepOrder: [],
                        startedAt: Date.now(),
                        settle: resolve,
                     };
                     deployment.replicas.set(replicaKey(identity), tracked);

                     const request: ReplicaDeployRequest = {
                        deploymentId,
                        task,
                        revision: options.revision,
                        commitSha: options.commitSha,
                     };

                     try {
                        // The ack window is short: it only carries accepted/rejected.
                        target.socket
                           .timeout(15_000)
                           .emit(REPLICA_DEPLOY_EVENT, request, (err: Error | null, ack: ReplicaDeployAck) => {
                              if (err || !ack) {
                                 this.settle(deployment, tracked, "timed_out", "Replica did not acknowledge the deploy request");
                                 return;
                              }
                              if (!ack.accepted) {
                                 this.settle(deployment, tracked, "rejected", ack.reason ?? "Replica rejected the deployment");
                                 return;
                              }
                              // Seed the steps the replica told us it will run, so the UI
                              // can show the full plan before any output arrives.
                              for (const name of ack.steps ?? []) this.ensureStep(tracked, name);
                              options.onProgress?.({ type: "accepted", replica: identity, steps: ack.steps ?? [] });
                              tracked.timer = setTimeout(
                                 () => this.settle(deployment, tracked, "timed_out", `No result within ${Math.round(timeoutMs / 1000)}s`),
                                 timeoutMs,
                              );
                              tracked.timer.unref?.();
                           });
                     } catch (e) {
                        this.settle(deployment, tracked, "failed", `Could not send deploy request: ${(e as Error).message}`);
                     }
                  }),
            ),
         );

         return this.summarize(deployment);
      } finally {
         for (const tracked of deployment.replicas.values()) {
            if (tracked.timer) clearTimeout(tracked.timer);
         }
         this.inFlight.delete(deploymentId);
      }
   }

   /** Best-effort cancel of a fan-out; replicas are asked to stop. */
   public cancel(deploymentId: string): void {
      const deployment = this.inFlight.get(deploymentId);
      if (!deployment) return;
      for (const tracked of deployment.replicas.values()) {
         if (tracked.state !== "running") continue;
         this.registry.socketFor(tracked.identity)?.emit(REPLICA_DEPLOY_CANCEL_EVENT, { deploymentId });
         this.settle(deployment, tracked, "failed", "Cancelled");
      }
   }

   // ── inbound events, routed here by the gateway ───────────────────────────

   public handleOutput(identity: ReplicaIdentity, payload: ReplicaDeployOutput): void {
      const found = this.locate(payload?.deploymentId, identity);
      if (!found) return;
      const { deployment, tracked } = found;
      const step = this.ensureStep(tracked, payload.step);
      step.output += payload.chunk ?? "";
      if (step.output.length > MAX_STEP_OUTPUT) {
         const dropped = step.output.length - MAX_STEP_OUTPUT;
         step.output = `…[${dropped} earlier bytes trimmed]…\n` + step.output.slice(-MAX_STEP_OUTPUT);
      }
      deployment.options.onProgress?.({
         type: "output",
         replica: tracked.identity,
         step: payload.step,
         chunk: payload.chunk ?? "",
      });
   }

   public handleStep(identity: ReplicaIdentity, payload: ReplicaDeployStepUpdate): void {
      const found = this.locate(payload?.deploymentId, identity);
      if (!found) return;
      const { deployment, tracked } = found;
      const step = this.ensureStep(tracked, payload.step);
      step.status = payload.status;
      step.error = payload.error;
      deployment.options.onProgress?.({
         type: "step",
         replica: tracked.identity,
         step: payload.step,
         status: payload.status,
         error: payload.error,
      });
   }

   public handleResult(identity: ReplicaIdentity, payload: ReplicaDeployResult): void {
      const found = this.locate(payload?.deploymentId, identity);
      if (!found) return;
      const { deployment, tracked } = found;

      // Fold in the replica's own per-step summary; it is authoritative for status
      // and covers steps whose events were dropped by a flaky link.
      for (const summary of payload.steps ?? []) {
         const step = this.ensureStep(tracked, summary.name);
         step.status = summary.status;
         step.error = summary.error ?? step.error;
      }

      tracked.restarting = payload.restarting;
      this.settle(
         deployment,
         tracked,
         payload.status === "success" ? "success" : "failed",
         payload.error,
      );
   }

   // ── internals ────────────────────────────────────────────────────────────

   private locate(deploymentId: string | undefined, identity: ReplicaIdentity) {
      if (!deploymentId) return null;
      const deployment = this.inFlight.get(deploymentId);
      if (!deployment) return null;
      const tracked = deployment.replicas.get(replicaKey(identity));
      // Late events after a timeout are expected; drop them rather than reviving
      // a replica that has already been settled.
      if (!tracked || tracked.state !== "running") return null;
      return { deployment, tracked };
   }

   private ensureStep(tracked: TrackedReplica, name: string): ReplicaStepReport {
      const existing = tracked.steps.get(name);
      if (existing) return existing;
      const created: ReplicaStepReport = { name, status: "running", output: "" };
      tracked.steps.set(name, created);
      tracked.stepOrder.push(name);
      return created;
   }

   /** Marks a replica terminal exactly once and releases the waiter. */
   private settle(
      deployment: InFlightDeployment,
      tracked: TrackedReplica,
      state: ReplicaDeploymentState,
      reason?: string,
   ): void {
      if (tracked.state !== "running") return;
      tracked.state = state;
      tracked.reason = reason;
      tracked.settledAt = Date.now();
      if (tracked.timer) clearTimeout(tracked.timer);

      const label = `${tracked.identity.deviceName} @ ${tracked.identity.ip}`;
      if (state === "success") {
         this.logger.log(`Deployment ${deployment.deploymentId}: ${label} succeeded`);
      } else {
         this.logger.warn(`Deployment ${deployment.deploymentId}: ${label} ${state}${reason ? ` — ${reason}` : ""}`);
      }

      deployment.options.onProgress?.({ type: "settled", replica: tracked.identity, state, reason });
      tracked.settle();
   }

   private summarize(deployment: InFlightDeployment): ReplicaDeploymentSummary {
      const reports: ReplicaDeploymentReport[] = [...deployment.replicas.values()].map((tracked) => ({
         ip: tracked.identity.ip,
         deviceName: tracked.identity.deviceName,
         state: tracked.state,
         reason: tracked.reason,
         steps: tracked.stepOrder.map((name) => tracked.steps.get(name)!),
         durationMs: (tracked.settledAt ?? Date.now()) - tracked.startedAt,
         restarting: tracked.restarting,
      }));

      const succeeded = reports.filter((r) => r.state === "success").length;
      // A rejection is a configuration statement ("I don't run that task"), not a
      // deployment failure, so it does not fail the fan-out — it is surfaced in the
      // report instead. Failures, timeouts and disconnects do.
      const failed = reports.filter(
         (r) => r.state === "failed" || r.state === "timed_out" || r.state === "disconnected",
      ).length;

      return {
         deploymentId: deployment.deploymentId,
         task: deployment.task,
         reports,
         ok: failed === 0,
         attempted: reports.length,
         succeeded,
         failed,
      };
   }
}
