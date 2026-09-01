/**
 * Shared vocabulary for the pipeline (release) domain.
 *
 * The model deliberately mirrors the concepts of a stage/promotion based release
 * system: a pipeline is an ordered set of *stages*, each stage holds *targets*
 * (the things that actually get built/deployed), stages are connected by
 * *promotions* (the arrows), promotions can carry *blockers* (time windows,
 * alarms, locks, manual gates) and a stage can own an *approval workflow* whose
 * steps must all pass before revisions become eligible for promotion.
 * Stages may additionally be grouped into *waves* for batched rollouts.
 */

/** What a stage represents. Drives the icon + card layout in the UI. */
export enum StageKind {
   /** Entry stage: source packages / repositories being watched. */
   Packages = "PACKAGES",
   /** The aggregate build artifact all packages land in. */
   VersionSet = "VERSION_SET",
   /** A deployable environment (alpha/beta/gamma/prod...). */
   Deployable = "DEPLOYABLE",
   /** Anything else: a generic command target. */
   Generic = "GENERIC",
}

/** What a single target inside a stage is. */
export enum TargetKind {
   Package = "PKG",
   VersionSet = "VS",
   Environment = "ENV",
   Generic = "GEN",
}

/**
 * Automation state of a promotion — this is what colours the arrow.
 *  - On       → green arrow, revisions promote automatically
 *  - Off      → grey arrow, promotion exists but only ever runs manually
 *  - Disabled → red arrow, explicitly switched off by a human (andon cord)
 */
export enum PromotionState {
   On = "ON",
   Off = "OFF",
   Disabled = "DISABLED",
}

/** The kind of work a promotion performs when it fires. */
export enum PromotionKind {
   BuildPackage = "BUILD_PACKAGE",
   DeployVersionSet = "DEPLOY_VS",
   PromoteEnv = "PROMOTE_ENV",
   Generic = "GENERIC",
}

/** Why a promotion is being held back. */
export enum BlockerKind {
   /** Only promote inside a recurring window (e.g. Mon–Thu 09:00–16:00). */
   TimeWindow = "TIME_WINDOW",
   /** An external monitor/alarm; while firing, nothing promotes. */
   Alarm = "ALARM",
   /** Another workflow is holding the destination environment. */
   Lock = "LOCK",
   /** A human must press approve. */
   ManualApproval = "MANUAL_APPROVAL",
}

export enum BlockerState {
   Ok = "OK",
   Blocking = "BLOCKING",
   Unknown = "UNKNOWN",
}

/** How the stages inside a wave are released relative to each other. */
export enum WaveKind {
   /** Only one member of the wave may be deploying at a time (+ optional bake). */
   Exclusive = "EXCLUSIVE",
   /** Members start N minutes apart. */
   Staggered = "STAGGERED",
}

/** Lifecycle of a whole pipeline run. */
export enum RunStatus {
   Pending = "PENDING",
   Running = "RUNNING",
   AwaitingApproval = "AWAITING_APPROVAL",
   Blocked = "BLOCKED",
   Succeeded = "SUCCEEDED",
   Failed = "FAILED",
   Cancelled = "CANCELLED",
}

/** Lifecycle of one target / workflow step inside a run. */
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "blocked" | "awaiting_approval";

/** Terminal states — a run in one of these is finished and immutable. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
   RunStatus.Succeeded,
   RunStatus.Failed,
   RunStatus.Cancelled,
];

export function isTerminalRunStatus(status: RunStatus): boolean {
   return TERMINAL_RUN_STATUSES.includes(status);
}

/** Result of executing a single target (or workflow step) within a run. */
export interface StepResult {
   /** Stable key: target name or workflow step name. */
   key: string;
   name: string;
   status: StepStatus;
   output: string;
   startedAt?: string;
   finishedAt?: string;
   error?: string;
   attempt?: number;
   maxAttempts?: number;
   exitCode?: number | null;
}

/** Result of running one stage within a run. */
export interface StageResult {
   stageId: number;
   stageName: string;
   kind: StageKind;
   status: StepStatus;
   startedAt?: string;
   finishedAt?: string;
   /** Keyed by target name. */
   targets: Record<string, StepResult>;
   /** Present when the stage owns an approval workflow. */
   workflow?: {
      name: string;
      status: StepStatus;
      steps: Record<string, StepResult>;
      approvedBy?: string;
      approvedAt?: string;
   };
   /** Human readable reason the stage could not be entered. */
   blockedReason?: string;
   /** Blocker ids that were holding this stage back. */
   blockedBy?: number[];
   error?: string;
}

/** Configuration payload stored on a blocker, shape depends on `kind`. */
export interface TimeWindowConfig {
   /** 0 = Sunday … 6 = Saturday. Empty means every day. */
   daysOfWeek: number[];
   /** Local time, inclusive, "HH:MM". */
   startTime: string;
   /** Local time, exclusive, "HH:MM". */
   endTime: string;
   /** IANA timezone the window is expressed in. */
   timezone?: string;
   /** When true the window describes when promotion is *forbidden*. */
   invert?: boolean;
}

export interface AlarmConfig {
   /** Free-form monitor identifier shown in the UI tooltip. */
   monitor: string;
   /** Optional HTTP endpoint polled for alarm state; 200 = OK, anything else = alarm. */
   healthUrl?: string;
   /** When no healthUrl is set this manual switch drives the state. */
   manualState?: BlockerState;
}

export interface LockConfig {
   /** Name of the resource being locked. */
   resource: string;
   heldBy?: string;
}

export interface ManualApprovalConfig {
   /** Optional list of usernames allowed to approve. Empty = any admin. */
   approvers?: string[];
   /** Message displayed to the approver. */
   prompt?: string;
}

export type BlockerConfig = TimeWindowConfig | AlarmConfig | LockConfig | ManualApprovalConfig;

/** Events pushed over SSE while a run executes. */
export type PipelineEventType =
   | "run_start"
   | "stage_start"
   | "stage_complete"
   | "step_start"
   | "step_output"
   | "step_complete"
   | "workflow_start"
   | "workflow_step_start"
   | "workflow_step_complete"
   | "workflow_complete"
   | "promotion_blocked"
   | "awaiting_approval"
   | "run_complete";

export interface PipelineEvent {
   type: PipelineEventType;
   runId?: string;
   stageId?: number;
   stageName?: string;
   /** Target name or workflow step name. */
   key?: string;
   output?: string;
   status?: StepStatus;
   error?: string;
   reason?: string;
   startedAt?: string;
   finishedAt?: string;
   attempt?: number;
   maxAttempts?: number;
   /** Full run snapshot, sent on run_start / run_complete so clients can resync. */
   run?: unknown;
}
