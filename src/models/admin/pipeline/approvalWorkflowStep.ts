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
import { ApprovalWorkflow } from "./approvalWorkflow";

/**
 * One check inside an approval workflow. Steps with no dependencies run in the
 * first wave; a step runs once every step it depends on has succeeded.
 */
@Entity("approval_workflow_step")
export class ApprovalWorkflowStep extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   workflowId: number;

   @ManyToOne(() => ApprovalWorkflow, (workflow) => workflow.steps, { onDelete: "CASCADE" })
   @JoinColumn({ name: "workflowId" })
   workflow: ApprovalWorkflow;

   /** Unique within the workflow; referenced by other steps' `dependencies`. */
   @Column()
   name: string;

   @Column({ default: 0 })
   position: number;

   /**
    * A manual step does not run a command — it pauses the workflow until a human
    * approves it. Used to gate a stage behind a human decision.
    */
   @Column({ default: false })
   manual: boolean;

   @Column({ default: "" })
   cmd: string;

   /** JSON-serialised string[]. TEXT columns cannot carry a SQL default. */
   @Column({ type: "text", nullable: true })
   args: string | null;

   @Column({ default: "" })
   workDir: string;

   /** JSON-serialised string[] of sibling step names that must succeed first. */
   @Column({ type: "text", nullable: true })
   dependencies: string | null;

   @Column({ default: 1 })
   maxAttempts: number;

   @Column({ default: 0 })
   timeoutMs: number;

   @Column({ default: true })
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   getArgs(): string[] {
      return parseStringArray(this.args);
   }

   setArgs(args: string[]) {
      this.args = JSON.stringify(args ?? []);
   }

   getDependencies(): string[] {
      return parseStringArray(this.dependencies);
   }

   setDependencies(dependencies: string[]) {
      this.dependencies = JSON.stringify(dependencies ?? []);
   }
}

function parseStringArray(raw: string | null | undefined): string[] {
   try {
      const parsed = JSON.parse(raw ?? "[]");
      return Array.isArray(parsed) ? parsed.map(String) : [];
   } catch {
      return [];
   }
}
