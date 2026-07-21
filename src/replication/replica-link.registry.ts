import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";
import {
   HAS_FILE_EVENT,
   DEPLOY_EVENT,
   READ_CONFIG_EVENT,
   WRITE_CONFIG_EVENT,
   type HasFileReply,
   type HasFileRequest,
   type DeployRequest,
   type ReadConfigReply,
   type WriteConfigRequest,
   type WriteConfigReply,
} from "./replica-link.constants";

interface ConnectedReplica {
   socket: Socket;
   ip: string;
   deviceName: string;
   mirrorDirs: number;
   connectedAt: number;
}

/** A connected replica, as surfaced to the admin API (no live socket handle). */
export interface ConnectedReplicaInfo {
   /** Stable id for this connection (the socket id) — used to target config/deploy ops. */
   id: string;
   ip: string;
   deviceName: string;
   mirrorDirs: number;
   connectedAt: number;
}

/** One replica the master just pushed a deploy to. */
export interface DeployTarget {
   id: string;
   ip: string;
   deviceName: string;
}

/** One live replica's answer to a file query (null report = timed out / errored). */
export interface ReplicaFileResult {
   ip: string;
   deviceName: string;
   mirrorDirs: number;
   report: HasFileReply | null;
}

/**
 * Process-wide registry of replicas currently connected to this (master) node over the
 * replica-link socket. Held as a global provider so both the WebSocket gateway (which
 * populates it) and FilesService (which queries it for the backups API) can share it
 * without a cross-module dependency.
 */
@Injectable()
export class ReplicaLinkRegistry {
   private readonly logger = new Logger(ReplicaLinkRegistry.name);
   private readonly replicas = new Map<string, ConnectedReplica>();

   register(socket: Socket, ip: string, deviceName: string, mirrorDirs: number): void {
      this.replicas.set(socket.id, { socket, ip, deviceName, mirrorDirs, connectedAt: Date.now() });
      this.logger.log(`Replica connected: ${deviceName} @ ${ip} (socket ${socket.id}, ${mirrorDirs} mirror disk(s)); ${this.replicas.size} online`);
   }

   unregister(socketId: string): void {
      const existing = this.replicas.get(socketId);
      if (this.replicas.delete(socketId)) {
         this.logger.log(`Replica disconnected: ${existing?.deviceName ?? "?"} @ ${existing?.ip ?? "?"} (socket ${socketId}); ${this.replicas.size} online`);
      }
   }

   /** IPs of all currently-connected replicas. */
   connectedIps(): string[] {
      return [...this.replicas.values()].map((r) => r.ip);
   }

   connectedCount(): number {
      return this.replicas.size;
   }

   /**
    * Ask every connected replica whether it currently has `path` (cloud-dir-relative),
    * in parallel, each bounded by `timeoutMs`. A replica that doesn't answer in time
    * yields `{ report: null }` so the caller can render it as "could not verify".
    *
    * Default is generous (15s): the replica's per-minute sync cron can block its event
    * loop with synchronous filesystem work, delaying the ack even though the check itself
    * (a few existsSync calls) is trivial.
    */
   async queryFile(path: string, timeoutMs = 15000): Promise<ReplicaFileResult[]> {
      const entries = [...this.replicas.values()];
      return Promise.all(
         entries.map(
            (entry) =>
               new Promise<ReplicaFileResult>((resolve) => {
                  try {
                     entry.socket
                        .timeout(timeoutMs)
                        .emit(HAS_FILE_EVENT, { path } as HasFileRequest, (err: Error | null, reply: HasFileReply) => {
                           resolve({ ip: entry.ip, deviceName: entry.deviceName, mirrorDirs: entry.mirrorDirs, report: err ? null : reply });
                        });
                  } catch (e) {
                     this.logger.debug(`queryFile emit failed for ${entry.deviceName} @ ${entry.ip}: ${(e as Error).message}`);
                     resolve({ ip: entry.ip, deviceName: entry.deviceName, mirrorDirs: entry.mirrorDirs, report: null });
                  }
               }),
         ),
      );
   }

   // ─────────────────────────── Deploy propagation ───────────────────────────

   /** Connected replicas, as plain info objects for the admin API. */
   list(): ConnectedReplicaInfo[] {
      return [...this.replicas.entries()].map(([id, r]) => ({
         id,
         ip: r.ip,
         deviceName: r.deviceName,
         mirrorDirs: r.mirrorDirs,
         connectedAt: r.connectedAt,
      }));
   }

   /**
    * Push a deploy request to every connected replica. Returns the replicas it was sent
    * to (so the caller can seed per-replica UI state). Fire-and-forget: live progress
    * comes back asynchronously over the same sockets as deploy-output/step/complete
    * events (handled by the gateway).
    */
   broadcastDeploy(request: DeployRequest): DeployTarget[] {
      const targets: DeployTarget[] = [];
      for (const [id, entry] of this.replicas.entries()) {
         try {
            entry.socket.emit(DEPLOY_EVENT, request);
            targets.push({ id, ip: entry.ip, deviceName: entry.deviceName });
         } catch (e) {
            this.logger.warn(`broadcastDeploy emit failed for ${entry.deviceName} @ ${entry.ip}: ${(e as Error).message}`);
         }
      }
      this.logger.log(`Pushed deploy "${request.project}" (deployId ${request.deployId}) to ${targets.length} replica(s)`);
      return targets;
   }

   /** Ask one replica to return its own .env / config.yml content. */
   async readConfig(replicaId: string, timeoutMs = 10000): Promise<ReadConfigReply> {
      const entry = this.replicas.get(replicaId);
      if (!entry) throw new Error("Replica is not connected");
      return new Promise<ReadConfigReply>((resolve, reject) => {
         entry.socket.timeout(timeoutMs).emit(READ_CONFIG_EVENT, {}, (err: Error | null, reply: ReadConfigReply) => {
            if (err) reject(new Error("Replica did not respond in time"));
            else resolve(reply);
         });
      });
   }

   /** Ask one replica to overwrite its own .env / config.yml content. */
   async writeConfig(replicaId: string, content: string, timeoutMs = 10000): Promise<WriteConfigReply> {
      const entry = this.replicas.get(replicaId);
      if (!entry) throw new Error("Replica is not connected");
      return new Promise<WriteConfigReply>((resolve, reject) => {
         entry.socket
            .timeout(timeoutMs)
            .emit(WRITE_CONFIG_EVENT, { content } as WriteConfigRequest, (err: Error | null, reply: WriteConfigReply) => {
               if (err) reject(new Error("Replica did not respond in time"));
               else resolve(reply);
            });
      });
   }
}
