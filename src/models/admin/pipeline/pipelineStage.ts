import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   JoinColumn,
   ManyToOne,
   OneToMany,
   OneToOne,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";
import { Pipeline } from "./pipeline";
import { PipelineWave } from "./pipelineWave";
import { PipelineTarget } from "./pipelineTarget";
import { ApprovalWorkflow } from "./approvalWorkflow";
import { StageKind } from "./pipeline.types";

/** One column in the pipeline graph. Holds targets and may own an approval workflow. */
@Entity("pipeline_stage")
export class PipelineStage extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   pipelineId: number;

   @ManyToOne(() => Pipeline, (pipeline) => pipeline.stages, { onDelete: "CASCADE" })
   @JoinColumn({ name: "pipelineId" })
   pipeline: Pipeline;

   /** Null when the stage does not belong to a wave. */
   @Column({ nullable: true })
   waveId: number | null;

   @ManyToOne(() => PipelineWave, (wave) => wave.stages, { onDelete: "SET NULL", nullable: true })
   @JoinColumn({ name: "waveId" })
   wave: PipelineWave | null;

   @Column()
   name: string;

   @Column({ type: "varchar", length: 32, default: StageKind.Generic })
   kind: StageKind;

   /** Left-to-right ordering within the pipeline. */
   @Column({ default: 0 })
   position: number;

   /** Production stages are visually flagged and get an extra confirmation. */
   @Column({ default: false })
   isProd: boolean;

   @Column({ type: "text", nullable: true })
   description: string | null;

   /** A disabled stage is skipped entirely (targets are not executed). */
   @Column({ default: true })
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   @OneToMany(() => PipelineTarget, (target) => target.stage)
   targets: PipelineTarget[];

   @OneToOne(() => ApprovalWorkflow, (workflow) => workflow.stage)
   approvalWorkflow: ApprovalWorkflow | null;
}
