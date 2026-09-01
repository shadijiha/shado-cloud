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
import { PipelineStage } from "./pipelineStage";
import { TargetKind } from "./pipeline.types";

/**
 * A single unit of work inside a stage — one card in the stage column.
 * Executing a target means running `cmd args...` in `workDir`.
 */
@Entity("pipeline_target")
export class PipelineTarget extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   stageId: number;

   @ManyToOne(() => PipelineStage, (stage) => stage.targets, { onDelete: "CASCADE" })
   @JoinColumn({ name: "stageId" })
   stage: PipelineStage;

   /** Unique within the stage; used as the key in run results. */
   @Column()
   name: string;

   @Column({ type: "varchar", length: 16, default: TargetKind.Generic })
   kind: TargetKind;

   @Column({ default: 0 })
   position: number;

   @Column({ default: "" })
   cmd: string;

   /** JSON-serialised string[]. TEXT columns cannot carry a SQL default, so the accessors below tolerate NULL. */
   @Column({ type: "text", nullable: true })
   args: string | null;

   /** Overrides the pipeline `workDir` when non-empty. `__CWD__` = process.cwd(). */
   @Column({ default: "" })
   workDir: string;

   /** Optional external link rendered on the card (build page, environment, repo...). */
   @Column({ type: "text", nullable: true })
   url: string | null;

   /**
    * The command restarts this process. The target is marked successful before the
    * command is fired and the run resumes from the following stage after boot.
    */
   @Column({ default: false })
   triggersRestart: boolean;

   /** Permanently skipped without removing it from the pipeline. */
   @Column({ default: false })
   skip: boolean;

   /** How many times to attempt the command before failing the target. */
   @Column({ default: 3 })
   maxAttempts: number;

   /** Hard timeout in milliseconds. 0 = no timeout. */
   @Column({ default: 0 })
   timeoutMs: number;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   getArgs(): string[] {
      try {
         const parsed = JSON.parse(this.args ?? "[]");
         return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
         return [];
      }
   }

   setArgs(args: string[]) {
      this.args = JSON.stringify(args ?? []);
   }
}
