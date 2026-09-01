import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { StepRunnerService } from "src/admin/pipelines/step-runner.service";
import type {
   ReplicaDeployAck,
   ReplicaDeployRequest,
   ReplicaDeployResult,
   ReplicaDeployStatus,
   ReplicaDeployStepSummary,
} from "./replica-link.constants";

/**
 * How the executor reports progress. Deliberately an interface rather than a
 * socket: the executor knows nothing about transport, so it can be unit tested
 * with a recording reporter and reused if the link is ever replaced.
 */
export interface DeployReporter {
   output(step: string, chunk: string): void;
   step(step: string, status: ReplicaDeployStatus, detail?: { error?: string; exitCode?: number | null }): void;
}

/**
 * Runs a deployment on a REPLICA node.
 *
 * The master only ever sends a task *name*; this class resolves it against the
 * replica's own `replication.deploy-tasks` config and runs those commands. A
 * replica that declares no tasks rejects every request, so an existing
 * installation does not silently gain a remote execution channel on upgrade.
 *
 * One deployment at a time, matching the reentrancy convention used by
 * ReplicationService's sync crons.
 */
@Injectable()
export class ReplicaDeploymentExecutor {
   private readonly logger = new Logger(ReplicaDeploymentExecutor.name);

   /** Non-null while a deployment is running; also the cancel handle. */
   private active: { deploymentId: string; cancelled: boolean } | null = null;

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly runner: StepRunnerService,
   ) {}

   private tasks() {
      return this.config.get("this-service.replication.deploy-tasks", { infer: true }) ?? [];
   }

   private findTask(name: string) {
      return this.tasks().find((task) => task.name === name);
   }

   /** Task names this replica is willing to run. Exposed for diagnostics. */
   public availableTasks(): string[] {
      return this.tasks().map((task) => task.name);
   }

   /**
    * Decides whether a request can run, without starting it. Returning
    * `accepted: false` is a normal answer, not an error.
    */
   public accept(request: ReplicaDeployRequest): ReplicaDeployAck {
      if (!request?.deploymentId || !request?.task) {
         return { accepted: false, reason: "Malformed deploy request" };
      }
      if (this.active) {
         return { accepted: false, reason: `Already running deployment ${this.active.deploymentId}` };
      }
      const task = this.findTask(request.task);
      if (!task) {
         const known = this.availableTasks();
         return {
            accepted: false,
            reason: known.length
               ? `Unknown deploy task "${request.task}" (this replica declares: ${known.join(", ")})`
               : `This replica declares no deploy tasks, so "${request.task}" cannot be run`,
         };
      }
      if (!task.steps?.length) {
         return { accepted: false, reason: `Deploy task "${request.task}" has no steps` };
      }
      return { accepted: true, steps: task.steps.map((step) => step.name) };
   }

   /** Best-effort cancellation of the in-flight deployment. */
   public cancel(deploymentId: string): boolean {
      if (!this.active || this.active.deploymentId !== deploymentId) return false;
      this.active.cancelled = true;
      this.runner.cancelAll(`${deploymentId}:`);
      this.logger.warn(`Deployment ${deploymentId} cancelled by master`);
      return true;
   }

   /**
    * Runs the task to completion and resolves with the terminal result.
    *
    * Never rejects: a failure is a result with `status: "failed"`, because the
    * caller's job is to relay an outcome to the master, and an exception would
    * leave the master waiting for a report that never arrives.
    */
   public async run(request: ReplicaDeployRequest, reporter: DeployReporter): Promise<ReplicaDeployResult> {
      const startedAt = Date.now();
      const steps: ReplicaDeployStepSummary[] = [];
      const task = this.findTask(request.task);

      if (!task) {
         return {
            deploymentId: request.deploymentId,
            status: "failed",
            error: `Unknown deploy task "${request.task}"`,
            steps,
            durationMs: 0,
         };
      }

      this.active = { deploymentId: request.deploymentId, cancelled: false };
      this.logger.log(
         `Deployment ${request.deploymentId} started: task "${task.name}"` +
            `${request.revision ? ` (revision ${request.revision})` : ""}`,
      );

      try {
         for (const step of task.steps) {
            if (this.active?.cancelled) {
               steps.push({ name: step.name, status: "skipped", error: "Cancelled", durationMs: 0 });
               reporter.step(step.name, "skipped", { error: "Cancelled" });
               return this.finish(request, "failed", steps, startedAt, "Cancelled by master");
            }

            const stepStartedAt = Date.now();
            const cwd = this.runner.resolveWorkDir(step["work-dir"], task["work-dir"]);
            reporter.step(step.name, "running");

            // A step that restarts this process must be reported as done and the
            // whole result flushed BEFORE it fires — afterwards there is no socket
            // to report on, and the master would otherwise see an unexplained
            // disconnect and assume failure.
            if (step["triggers-restart"]) {
               reporter.output(step.name, `Firing restart: ${step.cmd} ${(step.args ?? []).join(" ")}\n`);
               reporter.step(step.name, "success");
               steps.push({ name: step.name, status: "success", durationMs: Date.now() - stepStartedAt });
               const result = this.finish(request, "success", steps, startedAt, undefined, true);
               this.runner.spawnDetached(step.cmd, step.args ?? [], cwd);
               return result;
            }

            try {
               const { exitCode } = await this.runner.run(`${request.deploymentId}:${step.name}`, {
                  cmd: step.cmd,
                  args: step.args ?? [],
                  cwd,
                  timeoutMs: step["timeout-ms"] ?? 0,
                  onOutput: (chunk) => reporter.output(step.name, chunk),
               });
               reporter.step(step.name, "success", { exitCode });
               steps.push({ name: step.name, status: "success", durationMs: Date.now() - stepStartedAt });
            } catch (error) {
               const e = error as Error;
               reporter.output(step.name, `\n${e.message}\n`);
               reporter.step(step.name, "failed", { error: e.message });
               steps.push({ name: step.name, status: "failed", error: e.message, durationMs: Date.now() - stepStartedAt });
               this.logger.error(`Deployment ${request.deploymentId} failed at "${step.name}": ${e.message}`);
               return this.finish(request, "failed", steps, startedAt, `Step "${step.name}" failed: ${e.message}`);
            }
         }

         return this.finish(request, "success", steps, startedAt);
      } catch (error) {
         // Defensive: anything unexpected still has to become a reportable result.
         const e = error as Error;
         this.logger.error(`Deployment ${request.deploymentId} errored: ${e.message}`, e.stack);
         return this.finish(request, "failed", steps, startedAt, e.message);
      } finally {
         this.active = null;
      }
   }

   private finish(
      request: ReplicaDeployRequest,
      status: "success" | "failed",
      steps: ReplicaDeployStepSummary[],
      startedAt: number,
      error?: string,
      restarting = false,
   ): ReplicaDeployResult {
      const durationMs = Date.now() - startedAt;
      if (status === "success") {
         this.logger.log(
            `Deployment ${request.deploymentId} succeeded in ${Math.round(durationMs / 1000)}s` +
               `${restarting ? " (restart pending)" : ""}`,
         );
      }
      return { deploymentId: request.deploymentId, status, error, steps, durationMs, restarting };
   }
}
