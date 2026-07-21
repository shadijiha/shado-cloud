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

/* ───────────────────────────── Deploy propagation ─────────────────────────────
 *
 * When a deployment succeeds on the master and the project has "propagate to replicas"
 * enabled, the master pushes a `deploy` event down each replica-link socket carrying the
 * exact commands to run (a filtered subset of the master's own deploy steps — the ones
 * flagged runOnReplica). The replica runs them locally and streams the console output,
 * per-step status, and a final result back over the SAME socket, so the master's admin UI
 * can show a live console per replica (identified by IP + device name).
 */

/** Master → replica: run this deployment now. */
export const DEPLOY_EVENT = "deploy";
/** Replica → master: a chunk of live console output for the running deploy. */
export const DEPLOY_OUTPUT_EVENT = "deploy-output";
/** Replica → master: a single step changed status (running/success/failed/skipped). */
export const DEPLOY_STEP_EVENT = "deploy-step";
/** Replica → master: the whole deploy finished (success/failed). */
export const DEPLOY_COMPLETE_EVENT = "deploy-complete";

/** Master → replica (ack): read the replica's own .env / config.yml. */
export const READ_CONFIG_EVENT = "read-config";
/** Master → replica (ack): overwrite the replica's own .env / config.yml. */
export const WRITE_CONFIG_EVENT = "write-config";

export type ReplicaDeployStepStatus = "running" | "success" | "failed" | "skipped";
export type ReplicaDeployStatus = "running" | "success" | "failed";

/** One command the replica should run (a projection of the master's DeploymentStepConfig). */
export interface DeployStep {
   step: string;
   name: string;
   cmd: string;
   args: string[];
   /** If true, this step restarts the replica process — remaining steps are dropped. */
   triggersRestart?: boolean;
}

/** Master → replica payload for {@link DEPLOY_EVENT}. */
export interface DeployRequest {
   /** Correlates all output/step/complete messages for one propagation run. */
   deployId: string;
   project: string;
   steps: DeployStep[];
}

/** Replica → master: streamed console output. */
export interface DeployOutputMsg {
   deployId: string;
   step: string;
   output: string;
}

/** Replica → master: a step transition. */
export interface DeployStepMsg {
   deployId: string;
   step: string;
   name: string;
   status: ReplicaDeployStepStatus;
   error?: string;
}

/** Replica → master: terminal result for the whole run. */
export interface DeployCompleteMsg {
   deployId: string;
   project: string;
   status: ReplicaDeployStatus;
   error?: string;
}

/** Replica → master ack for {@link READ_CONFIG_EVENT}. */
export interface ReadConfigReply {
   /** True if a .env or config.yml was found. */
   found: boolean;
   /** Base name of the file that was read (".env" or "config.yml"). */
   filename: string | null;
   content: string;
}

/** Master → replica payload for {@link WRITE_CONFIG_EVENT}. */
export interface WriteConfigRequest {
   content: string;
}

/** Replica → master ack for {@link WRITE_CONFIG_EVENT}. */
export interface WriteConfigReply {
   success: boolean;
   filename: string | null;
   message?: string;
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
