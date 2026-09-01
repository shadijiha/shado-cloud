import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";
import { HAS_FILE_EVENT, type HasFileReply, type HasFileRequest } from "./replica-link.constants";

interface ConnectedReplica {
   socket: Socket;
   ip: string;
   deviceName: string;
   mirrorDirs: number;
   connectedAt: number;
}

/** One live replica's answer to a file query (null report = timed out / errored). */
export interface ReplicaFileResult {
   ip: string;
   deviceName: string;
   mirrorDirs: number;
   report: HasFileReply | null;
}

/** Stable-ish logical identity of a replica: socket ids change on every reconnect. */
export interface ReplicaIdentity {
   ip: string;
   deviceName: string;
}

/** `ip|deviceName` — two replicas can share one public IP behind NAT. */
export function replicaKey(identity: ReplicaIdentity): string {
   return `${identity.ip}|${identity.deviceName ?? ""}`;
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

   /**
    * Disconnect observers. Anything tracking long-running work on a replica (a
    * deployment, say) needs to know the moment the socket drops, otherwise it
    * waits out a timeout for a report that can no longer arrive.
    */
   private readonly disconnectListeners = new Set<(identity: ReplicaIdentity, socketId: string) => void>();

   register(socket: Socket, ip: string, deviceName: string, mirrorDirs: number): void {
      this.replicas.set(socket.id, { socket, ip, deviceName, mirrorDirs, connectedAt: Date.now() });
      this.logger.log(`Replica connected: ${deviceName} @ ${ip} (socket ${socket.id}, ${mirrorDirs} mirror disk(s)); ${this.replicas.size} online`);
   }

   unregister(socketId: string): void {
      const existing = this.replicas.get(socketId);
      if (this.replicas.delete(socketId)) {
         this.logger.log(`Replica disconnected: ${existing?.deviceName ?? "?"} @ ${existing?.ip ?? "?"} (socket ${socketId}); ${this.replicas.size} online`);
         if (existing) this.notifyDisconnect({ ip: existing.ip, deviceName: existing.deviceName }, socketId);
      }
   }

   /** Subscribe to replica disconnects. Returns an unsubscribe function. */
   onDisconnect(listener: (identity: ReplicaIdentity, socketId: string) => void): () => void {
      this.disconnectListeners.add(listener);
      return () => this.disconnectListeners.delete(listener);
   }

   private notifyDisconnect(identity: ReplicaIdentity, socketId: string): void {
      for (const listener of this.disconnectListeners) {
         // A misbehaving observer must not stop the others, nor the disconnect path.
         try {
            listener(identity, socketId);
         } catch (e) {
            this.logger.warn(`Replica disconnect listener threw: ${(e as Error).message}`);
         }
      }
   }

   /** Snapshot of connected replicas, for callers that need to fan out to each. */
   connected(): (ReplicaIdentity & { socket: Socket; mirrorDirs: number; socketId: string })[] {
      return [...this.replicas.entries()].map(([socketId, entry]) => ({
         socketId,
         socket: entry.socket,
         ip: entry.ip,
         deviceName: entry.deviceName,
         mirrorDirs: entry.mirrorDirs,
      }));
   }

   /** The live socket for a logical replica, if it is still connected. */
   socketFor(identity: ReplicaIdentity): Socket | undefined {
      const wanted = replicaKey(identity);
      for (const entry of this.replicas.values()) {
         if (replicaKey(entry) === wanted) return entry.socket;
      }
      return undefined;
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
}
