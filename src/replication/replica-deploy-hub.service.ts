import { Injectable, Logger, MessageEvent } from "@nestjs/common";
import { Subject, Observable } from "rxjs";
import type {
   DeployTarget,
} from "./replica-link.registry";
import type {
   ReplicaDeployStatus,
   ReplicaDeployStepStatus,
} from "./replica-link.constants";

interface ReplicaStepState {
   step: string;
   name: string;
   status: ReplicaDeployStepStatus;
   error?: string;
}

/** Live state of one replica's in-progress / last deploy, as tracked on the master. */
export interface ReplicaDeployState {
   deployId: string;
   replicaId: string;
   ip: string;
   deviceName: string;
   project: string;
   status: ReplicaDeployStatus;
   currentStep?: string;
   steps: Record<string, ReplicaStepState>;
   output: string;
   error?: string;
   startedAt: number;
   finishedAt?: number;
}

/**
 * Master-side fan-in for replica deploy progress.
 *
 * When the master propagates a deploy, {@link begin} seeds a "running" state per targeted
 * replica. As each replica streams back console output / step transitions / completion over
 * its replica-link socket, the {@link ReplicationGateway} forwards those into this hub, which
 * (a) keeps the latest state per replica (so the admin UI can hydrate on load) and (b)
 * re-emits every event on an RxJS Subject that the SSE endpoint streams to the browser.
 *
 * Lives in the GlobalUtilityModule (master process only) so both the gateway (which feeds it)
 * and the deployment controller (which streams from it) can share one instance.
 */
@Injectable()
export class ReplicaDeployHub {
   private readonly logger = new Logger(ReplicaDeployHub.name);
   private readonly subject = new Subject<MessageEvent>();
   /** Keyed by replicaId (socket id). Only the most recent run per replica is retained. */
   private readonly states = new Map<string, ReplicaDeployState>();

   stream(): Observable<MessageEvent> {
      return this.subject.asObservable();
   }

   getStates(): ReplicaDeployState[] {
      return [...this.states.values()].sort((a, b) => b.startedAt - a.startedAt);
   }

   private emit(event: Record<string, unknown>): void {
      this.subject.next({ data: JSON.stringify(event) } as MessageEvent);
   }

   /** Seed a running state for every replica the deploy was pushed to. */
   begin(deployId: string, project: string, targets: DeployTarget[]): void {
      for (const t of targets) {
         this.states.set(t.id, {
            deployId,
            replicaId: t.id,
            ip: t.ip,
            deviceName: t.deviceName,
            project,
            status: "running",
            steps: {},
            output: "",
            startedAt: Date.now(),
         });
         this.emit({ type: "targeted", deployId, replicaId: t.id, ip: t.ip, deviceName: t.deviceName, project });
      }
      this.logger.log(`Tracking replica deploy ${deployId} for ${targets.length} replica(s)`);
   }

   output(replicaId: string, ip: string, deviceName: string, deployId: string, step: string, output: string): void {
      const state = this.states.get(replicaId);
      if (state && state.deployId === deployId) {
         state.output += output;
         state.currentStep = step;
      }
      this.emit({ type: "output", deployId, replicaId, ip, deviceName, step, output });
   }

   step(
      replicaId: string,
      ip: string,
      deviceName: string,
      deployId: string,
      step: string,
      name: string,
      status: ReplicaDeployStepStatus,
      error?: string,
   ): void {
      const state = this.states.get(replicaId);
      if (state && state.deployId === deployId) {
         state.steps[step] = { step, name, status, error };
         if (status === "running") state.currentStep = step;
      }
      this.emit({ type: "step", deployId, replicaId, ip, deviceName, step, name, status, error });
   }

   complete(
      replicaId: string,
      ip: string,
      deviceName: string,
      deployId: string,
      project: string,
      status: ReplicaDeployStatus,
      error?: string,
   ): void {
      const state = this.states.get(replicaId);
      if (state && state.deployId === deployId) {
         state.status = status;
         state.error = error;
         state.finishedAt = Date.now();
      }
      this.emit({ type: "complete", deployId, replicaId, ip, deviceName, project, status, error });
      this.logger.log(`Replica deploy ${deployId} on ${deviceName} @ ${ip} finished: ${status}${error ? ` (${error})` : ""}`);
   }
}
