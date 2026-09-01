import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   JoinColumn,
   ManyToOne,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";
import { Pipeline } from "./pipeline";
import { RunStatus, StageResult } from "./pipeline.types";

/**
 * Durable history of one execution of a pipeline. Unlike the previous
 * implementation (which kept run state only in Redis with a 24h TTL) runs are
 * persisted, so the UI can show revision history and per-stage sparklines.
 */
@Entity("pipeline_run")
export class PipelineRun extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   /** Public identifier, e.g. "run_1730000000000". */
   @Column({ unique: true })
   runId: string;

   @Column()
   pipelineId: number;

   @ManyToOne(() => Pipeline, { onDelete: "CASCADE" })
   @JoinColumn({ name: "pipelineId" })
   pipeline: Pipeline;

   /** Denormalised so history survives pipeline renames. */
   @Column()
   pipelineSlug: string;

   /** Monotonic per-pipeline counter shown as "#42". */
   @Column({ default: 1 })
   sequence: number;

   /** Short revision label — a tag name, a short sha, or the run timestamp. */
   @Column({ default: "" })
   revision: string;

   // ── built commit ─────────────────────────────────────────────────────────
   // Captured from the GitHub push payload, or resolved from local git for
   // manually started runs, so every run records exactly what was built.

   @Column({ type: "varchar", length: 64, nullable: true })
   commitSha: string | null;

   @Column({ type: "text", nullable: true })
   commitUrl: string | null;

   @Column({ nullable: true })
   commitAuthor: string | null;

   @Column({ nullable: true })
   commitAuthorUsername: string | null;

   @Column({ type: "datetime", nullable: true })
   commitTimestamp: Date | null;

   /** Full ref, e.g. `refs/tags/v3.0.90`. */
   @Column({ nullable: true })
   gitRef: string | null;

   /** Ref without the prefix, e.g. `v3.0.90` or `master`. */
   @Column({ nullable: true })
   gitRefName: string | null;

   /** "branch" | "tag" | "unknown" | "local". */
   @Column({ type: "varchar", length: 16, nullable: true })
   gitRefType: string | null;

   /** `owner/repo` as reported by GitHub. */
   @Column({ nullable: true })
   repositoryName: string | null;

   @Column({ type: "text", nullable: true })
   compareUrl: string | null;

   /** JSON-serialised string[] of paths touched by the push. */
   @Column({ type: "text", nullable: true })
   changedFiles: string | null;

   /** Who pushed, per GitHub (often a bot for tag-based releases). */
   @Column({ nullable: true })
   pushedBy: string | null;

   @Column({ type: "varchar", length: 32, default: RunStatus.Pending })
   status: RunStatus;

   /** "admin", "github-webhook", "promotion", a username... */
   @Column({ default: "" })
   triggeredBy: string;

   @Column({ type: "text", nullable: true })
   commitMessage: string | null;

   /** Stage currently executing (null once terminal). */
   @Column({ nullable: true })
   currentStageId: number | null;

   /** JSON-serialised Record<stageId, StageResult>. */
   @Column({ type: "longtext" })
   stageResults: string;

   @Column({ type: "datetime", nullable: true })
   startedAt: Date | null;

   @Column({ type: "datetime", nullable: true })
   finishedAt: Date | null;

   @Column({ default: 0 })
   durationMs: number;

   @Column({ type: "text", nullable: true })
   error: string | null;

   /** Set when the run halted on a blocker, for the UI banner. */
   @Column({ type: "text", nullable: true })
   blockedReason: string | null;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   getStageResults(): Record<string, StageResult> {
      try {
         const parsed = JSON.parse(this.stageResults ?? "{}");
         return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
         return {};
      }
   }

   setStageResults(results: Record<string, StageResult>) {
      this.stageResults = JSON.stringify(results ?? {});
   }

   getChangedFiles(): string[] {
      try {
         const parsed = JSON.parse(this.changedFiles ?? "[]");
         return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
         return [];
      }
   }

   setChangedFiles(files: string[]) {
      this.changedFiles = JSON.stringify(files ?? []);
   }
}
