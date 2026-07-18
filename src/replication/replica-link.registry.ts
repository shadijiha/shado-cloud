import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";
import { HAS_FILE_EVENT, type HasFileReply, type HasFileRequest } from "./replica-link.constants";

interface ConnectedReplica {
   socket: Socket;
   ip: string;
   mirrorDirs: number;
   connectedAt: number;
}

/** One live replica's answer to a file query (null report = timed out / errored). */
export interface ReplicaFileResult {
   ip: string;
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

   register(socket: Socket, ip: string, mirrorDirs: number): void {
      this.replicas.set(socket.id, { socket, ip, mirrorDirs, connectedAt: Date.now() });
      this.logger.log(`Replica connected: ${ip} (socket ${socket.id}, ${mirrorDirs} mirror disk(s)); ${this.replicas.size} online`);
   }

   unregister(socketId: string): void {
      const existing = this.replicas.get(socketId);
      if (this.replicas.delete(socketId)) {
         this.logger.log(`Replica disconnected: ${existing?.ip ?? "?"} (socket ${socketId}); ${this.replicas.size} online`);
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
                           resolve({ ip: entry.ip, mirrorDirs: entry.mirrorDirs, report: err ? null : reply });
                        });
                  } catch (e) {
                     this.logger.debug(`queryFile emit failed for ${entry.ip}: ${(e as Error).message}`);
                     resolve({ ip: entry.ip, mirrorDirs: entry.mirrorDirs, report: null });
                  }
               }),
         ),
      );
   }
}
