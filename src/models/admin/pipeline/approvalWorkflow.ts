import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   JoinColumn,
   OneToMany,
   OneToOne,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";
import { PipelineStage } from "./pipelineStage";
import { ApprovalWorkflowStep } from "./approvalWorkflowStep";

/**
 * The acceptance criteria attached to a stage. Every step must pass before the
 * stage's revision is considered approved; promotions with `requiresApproval`
 * will not fire until then.
 */
@Entity("approval_workflow")
export class ApprovalWorkflow extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   /** One workflow per stage. Uniqueness is enforced by the one-to-one relation below. */
   @Column()
   stageId: number;

   @OneToOne(() => PipelineStage, (stage) => stage.approvalWorkflow, { onDelete: "CASCADE" })
   @JoinColumn({ name: "stageId" })
   stage: PipelineStage;

   @Column()
   name: string;

   /** A single step failing immediately cancels the remaining in-progress steps. */
   @Column({ default: false })
   rollbackOnFailure: boolean;

   /** Require every target in the stage to be on the same revision before running. */
   @Column({ default: false })
   requiresConsistentRevisions: boolean;

   @Column({ default: true })
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   @OneToMany(() => ApprovalWorkflowStep, (step) => step.workflow)
   steps: ApprovalWorkflowStep[];
}
