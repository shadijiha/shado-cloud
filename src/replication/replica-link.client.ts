import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { io, type Socket as ClientSocket } from "socket.io-client";
import * as path from "path";
import * as os from "os";
import { EnvVariables, ReplicationRole } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { signServiceHeaders } from "src/auth/service-auth.util";
import {
   HAS_FILE_EVENT,
   REPLICA_DEPLOY_CANCEL_EVENT,
   REPLICA_DEPLOY_EVENT,
   REPLICA_DEPLOY_OUTPUT_EVENT,
   REPLICA_DEPLOY_RESULT_EVENT,
   REPLICA_DEPLOY_STEP_EVENT,
   REPLICA_LINK_NAMESPACE,
   type HasFileReply,
   type HasFileRequest,
   type ReplicaDeployAck,
   type ReplicaDeployOutput,
   type ReplicaDeployRequest,
   type ReplicaDeployStatus,
   type ReplicaDeployStepUpdate,
   type ReplicaMirrorReport,
} from "./replica-link.constants";
import { ReplicaDeploymentExecutor } from "./replica-deployment.executor";

/** Output is batched on this interval so a chatty build does not flood the link. */
const OUTPUT_FLUSH_MS = 250;

/** Hard cap per batch; a single npm install can emit far more than one frame should carry. */
const OUTPUT_MAX_BATCH = 16 * 1024;

/**
 * Replica-side endpoint of the replica-link. Only active when this node's replication
 * role is Replica. Dials out to the master (which is publicly reachable) and answers
 * live "do you have this file?" queries by checking its own cloud-dir and configured
 * mirror disks. Socket.IO handles reconnection automatically.
 */
@Injectable()
export class ReplicaLinkClient implements OnModuleInit, OnModuleDestroy {
   private readonly logger = new Logger(ReplicaLinkClient.name);
   private socket?: ClientSocket;

   /** Per-deployment output buffer, flushed on a timer. */
   private outputBuffer = new Map<string, string>();
   private outputSeq = 0;
   private flushTimer?: ReturnType<typeof setInterval>;

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly fs: AbstractFileSystem,
      private readonly deployments: ReplicaDeploymentExecutor,
   ) {}

   onModuleInit(): void {
      const role = this.config.get("this-service.replication.role", { infer: true });
      if (role !== ReplicationRole.Replica) return;

      const masterHost = this.config.get("this-service.replication.master-or-replica-ip", { infer: true });
      if (!masterHost) {
         this.logger.error("Replica-link: master IP is not configured; not connecting");
         return;
      }

      const protocol = masterHost.includes("shadijiha.com") ? "https" : "http";
      const url = `${protocol}://${masterHost}`;
      const mirrorDirs = (this.config.get("this-service.replication.mirror-dirs", { infer: true }) ?? []).length;
      const secret = this.config.get("cross-service.secret", { infer: true });

      this.logger.log(`Replica-link: connecting to master at ${url}${REPLICA_LINK_NAMESPACE}`);

      this.socket = io(`${url}${REPLICA_LINK_NAMESPACE}`, {
         transports: ["websocket"],
         reconnection: true,
         reconnectionDelay: 5000,
         // `auth` is a function so a FRESH, time-bound HMAC is generated on every
         // (re)connection attempt — a stale signature would fail the 5-minute window.
         // The raw secret is never sent: signServiceHeaders' legacy x-service-key is stripped.
         auth: (cb: (data: Record<string, unknown>) => void) => {
            const headers = signServiceHeaders(secret) as Record<string, string>;
            delete headers["x-service-key"];
            cb({ ...headers, deviceName: os.hostname(), mirrorDirs });
         },
      });

      this.socket.on("connect", () => this.logger.log("Replica-link: connected to master"));
      this.socket.on("connect_error", (err) => this.logger.warn(`Replica-link: connect error: ${err.message}`));
      this.socket.on("disconnect", (reason) => this.logger.warn(`Replica-link: disconnected (${reason})`));

      // Master asks whether we currently have a file; reply with a live filesystem check.
      this.socket.on(HAS_FILE_EVENT, (req: HasFileRequest, ack?: (reply: HasFileReply) => void) => {
         const reply = this.checkFile(req?.path ?? "");
         if (typeof ack === "function") ack(reply);
      });

      // Master asks us to deploy. The ack only says whether we accepted; progress
      // and the outcome are pushed back as separate events.
      this.socket.on(REPLICA_DEPLOY_EVENT, (req: ReplicaDeployRequest, ack?: (reply: ReplicaDeployAck) => void) => {
         const decision = this.deployments.accept(req);
         if (typeof ack === "function") ack(decision);
         if (!decision.accepted) {
            this.logger.warn(`Rejected deploy request ${req?.deploymentId}: ${decision.reason}`);
            return;
         }
         void this.runDeployment(req);
      });

      this.socket.on(REPLICA_DEPLOY_CANCEL_EVENT, (req: { deploymentId: string }) => {
         this.deployments.cancel(req?.deploymentId ?? "");
      });

      this.flushTimer = setInterval(() => this.flushOutput(), OUTPUT_FLUSH_MS);
      // Never let the flush timer hold the process open on shutdown.
      this.flushTimer.unref?.();
   }

   /**
    * Runs a deployment and relays it to the master.
    *
    * Output is buffered and flushed on a timer rather than emitted per chunk: a
    * build can produce thousands of small writes, and one frame each would swamp
    * the link that also carries file-presence queries.
    */
   private async runDeployment(request: ReplicaDeployRequest): Promise<void> {
      const result = await this.deployments.run(request, {
         output: (step, chunk) => this.bufferOutput(request.deploymentId, step, chunk),
         step: (step, status, detail) => {
            // Flush pending output first so the master never sees a step marked
            // finished before the output that explains why.
            this.flushOutput();
            this.emitSafely(REPLICA_DEPLOY_STEP_EVENT, {
               deploymentId: request.deploymentId,
               step,
               status,
               error: detail?.error,
               exitCode: detail?.exitCode,
            } satisfies ReplicaDeployStepUpdate);
         },
      });

      this.flushOutput();
      this.emitSafely(REPLICA_DEPLOY_RESULT_EVENT, result);
   }

   private bufferOutput(deploymentId: string, step: string, chunk: string): void {
      const key = `${deploymentId}\u001f${step}`;
      const pending = (this.outputBuffer.get(key) ?? "") + chunk;
      if (pending.length >= OUTPUT_MAX_BATCH) {
         this.outputBuffer.set(key, pending);
         this.flushOutput();
         return;
      }
      this.outputBuffer.set(key, pending);
   }

   private flushOutput(): void {
      if (this.outputBuffer.size === 0) return;
      const batches = [...this.outputBuffer.entries()];
      this.outputBuffer.clear();
      for (const [key, chunk] of batches) {
         const [deploymentId, step] = key.split("\u001f");
         this.emitSafely(REPLICA_DEPLOY_OUTPUT_EVENT, {
            deploymentId,
            step,
            chunk,
            seq: ++this.outputSeq,
         } satisfies ReplicaDeployOutput);
      }
   }

   /**
    * Emits only when connected. A deployment that restarts this process, or one
    * that outlives a dropped link, must not throw on the way out — the master
    * falls back to its own timeout in that case.
    */
   private emitSafely(event: string, payload: unknown): void {
      if (!this.socket?.connected) {
         this.logger.warn(`Replica-link: dropping ${event}, socket not connected`);
         return;
      }
      try {
         this.socket.emit(event, payload);
      } catch (e) {
         this.logger.warn(`Replica-link: failed to emit ${event}: ${(e as Error).message}`);
      }
   }

   /** Live check of the replica's own cloud-dir + mirror disks for a cloud-dir-relative path. */
   private checkFile(relPath: string): HasFileReply {
      const safe = (p: string): boolean => {
         try {
            return this.fs.existsSync(p);
         } catch {
            return false;
         }
      };

      const cloudDir = this.config.get("this-service.cloud-dir", { infer: true });
      const mirrorDirs = this.config.get("this-service.replication.mirror-dirs", { infer: true }) ?? [];

      const mirrors: ReplicaMirrorReport[] = mirrorDirs.map((dir) => ({
         dir,
         // Only count the file as mirrored if the disk itself is mounted (root exists).
         present: safe(dir) && safe(path.join(dir, relPath)),
      }));

      return {
         cloudDir: relPath ? safe(path.join(cloudDir, relPath)) : false,
         mirrors,
      };
   }

   onModuleDestroy(): void {
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushOutput();
      this.socket?.disconnect();
   }
}
