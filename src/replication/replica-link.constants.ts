/**
 * Replica-link: a persistent control channel between the master and its replicas.
 *
 * Replicas are typically behind NAT / a Cloudflare tunnel and are NOT reachable from
 * the master. So the REPLICA dials OUT to the master (Socket.IO client → the master's
 * public URL) and keeps the connection open. The master can then ask a replica "do you
 * have this file?" over the existing socket and get a live, authoritative answer — used
 * by the file-backups API instead of inferring presence from sync timestamps.
 */

export const REPLICA_LINK_NAMESPACE = "/replica-link";

/** Master → replica: "do you currently have this file?" (ack-based request/response). */
export const HAS_FILE_EVENT = "has-file";

/** cloud-dir-relative path (same key mirror disks and replicas use). */
export interface HasFileRequest {
   path: string;
}

export interface ReplicaMirrorReport {
   /** The mirror-dir root as configured on the replica. */
   dir: string;
   present: boolean;
}

/** Replica → master ack payload for a HAS_FILE_EVENT. */
export interface HasFileReply {
   /** True if the file exists in the replica's own cloud-dir. */
   cloudDir: boolean;
   /** Per configured mirror disk on the replica. */
   mirrors: ReplicaMirrorReport[];
}

/** Handshake auth the replica presents when connecting to the master. */
export interface ReplicaLinkAuth {
   /** Shared cross-service secret (must equal the master's cross-service.secret). */
   token: string;
   /** Number of mirror disks configured on the replica (informational). */
   mirrorDirs: number;
}
