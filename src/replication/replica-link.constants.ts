/**
 * Replica-link: a persistent control channel between the master and its replicas.
 *
 * Replicas are typically behind NAT / a Cloudflare tunnel and are NOT reachable from
 * the master. So the REPLICA dials OUT to the master (Socket.IO client → the master's
 * public URL) and keeps the connection open. The master can then ask a replica "do you
 * have this file?" over the existing socket and get a live, authoritative answer — used
 * by the file-backups API instead of inferring presence from sync timestamps.
 */

export const REPLICA_LINK_NAMESPACE = "/replication/replica-link";

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
   /** Per-connection HMAC headers (same scheme as ServiceKeyGuard/signServiceHeaders). */
   "x-service-timestamp": string;
   "x-service-nonce": string;
   "x-service-signature": string;
   /** The replica's device name (os.hostname()) — combined with its IP to identify it. */
   deviceName: string;
   /** Number of mirror disks configured on the replica (informational). */
   mirrorDirs: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Deployment propagation
 *
 * The master can ask its replicas to run a deployment, and replicas stream the
 * result back. Two deliberate constraints shape this contract:
 *
 *  1. The wire carries a TASK NAME, never a command. The link is authenticated
 *     once, at the handshake, by a single shared secret; individual messages are
 *     not signed. If the master could ship `cmd`/`args`, anyone holding that
 *     secret could execute arbitrary code on every replica. Instead each replica
 *     resolves the task name against its own local config, so the master can only
 *     trigger work its operator has already declared.
 *
 *  2. The result does NOT come back in the emit ack. A deployment runs for
 *     minutes and streams output; an ack is a single value with a timeout. The
 *     ack therefore only reports ACCEPTED/REJECTED, and progress arrives as
 *     replica → master events correlated by `deploymentId`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Master → replica: "run this locally-configured deploy task" (ack = accepted/rejected only). */
export const REPLICA_DEPLOY_EVENT = "deploy";

/** Master → replica: "abandon this deployment". Best-effort. */
export const REPLICA_DEPLOY_CANCEL_EVENT = "deploy-cancel";

/** Replica → master: a chunk of console output. */
export const REPLICA_DEPLOY_OUTPUT_EVENT = "deploy-output";

/** Replica → master: one step changed state. */
export const REPLICA_DEPLOY_STEP_EVENT = "deploy-step";

/** Replica → master: the deployment reached a terminal state. */
export const REPLICA_DEPLOY_RESULT_EVENT = "deploy-result";

export type ReplicaDeployStatus = "running" | "success" | "failed" | "skipped";

export interface ReplicaDeployRequest {
   /** Correlates every subsequent event for this fan-out. */
   deploymentId: string;
   /** Name of a task declared in the replica's own `replication.deploy-tasks` config. */
   task: string;
   /** Informational: what the master was deploying (a tag or short sha). */
   revision?: string;
   commitSha?: string;
}

/**
 * Immediate ack. `accepted: false` is a normal outcome (unknown task, already
 * busy, deployments disabled) and must not be treated as a transport error.
 */
export interface ReplicaDeployAck {
   accepted: boolean;
   /** Human-readable reason when `accepted` is false. */
   reason?: string;
   /** Steps the replica is about to run, so the master can render them upfront. */
   steps?: string[];
}

export interface ReplicaDeployOutput {
   deploymentId: string;
   /** Step name the output belongs to. */
   step: string;
   chunk: string;
   /** Monotonic per-deployment counter so the master can detect dropped/reordered batches. */
   seq: number;
}

export interface ReplicaDeployStepUpdate {
   deploymentId: string;
   step: string;
   status: ReplicaDeployStatus;
   error?: string;
   exitCode?: number | null;
}

export interface ReplicaDeployStepSummary {
   name: string;
   status: ReplicaDeployStatus;
   error?: string;
   durationMs: number;
}

export interface ReplicaDeployResult {
   deploymentId: string;
   status: "success" | "failed";
   error?: string;
   steps: ReplicaDeployStepSummary[];
   durationMs: number;
   /**
    * True when the replica deliberately ended the deployment early because a step
    * restarts its own process — the result is sent *before* the restart fires, so
    * the master does not read the ensuing disconnect as a failure.
    */
   restarting?: boolean;
}

