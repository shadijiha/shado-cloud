import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   JoinColumn,
   ManyToOne,
   OneToMany,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";
import { Pipeline } from "./pipeline";
import { PipelineStage } from "./pipelineStage";
import { PipelinePromotionBlocker } from "./pipelinePromotionBlocker";
import { PromotionKind, PromotionState } from "./pipeline.types";

/**
 * The arrow between two stages. Owns the automation switch, whether the source
 * revision must be approved first, and any blockers holding it back.
 *
 * `sourceStageId === null` marks the pipeline entry promotion (what starts a run).
 */
@Entity("pipeline_promotion")
export class PipelinePromotion extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   pipelineId: number;

   @ManyToOne(() => Pipeline, (pipeline) => pipeline.promotions, { onDelete: "CASCADE" })
   @JoinColumn({ name: "pipelineId" })
   pipeline: Pipeline;

   @Column({ nullable: true })
   sourceStageId: number | null;

   @ManyToOne(() => PipelineStage, { onDelete: "CASCADE", nullable: true })
   @JoinColumn({ name: "sourceStageId" })
   sourceStage: PipelineStage | null;

   @Column()
   destStageId: number;

   @ManyToOne(() => PipelineStage, { onDelete: "CASCADE" })
   @JoinColumn({ name: "destStageId" })
   destStage: PipelineStage;

   @Column({ type: "varchar", length: 32, default: PromotionKind.Generic })
   kind: PromotionKind;

   @Column({ type: "varchar", length: 16, default: PromotionState.On })
   state: PromotionState;

   /**
    * When true the source stage's approval workflow must have granted approval
    * before this promotion may fire.
    */
   @Column({ default: false })
   requiresApproval: boolean;

   /** Label shown on the arrow when an approval is required, e.g. "manual". */
   @Column({ nullable: true })
   approvalName: string | null;

   @Column({ nullable: true })
   disabledBy: string | null;

   @Column({ type: "text", nullable: true })
   disabledMessage: string | null;

   @Column({ type: "datetime", nullable: true })
   disabledAt: Date | null;

   /**
    * One-shot override: when armed the next promotion attempt ignores all
    * blockers, then the flag is cleared again.
    */
   @Column({ default: false })
   bypassArmed: boolean;

   @Column({ nullable: true })
   bypassArmedBy: string | null;

   @Column({ type: "datetime", nullable: true })
   bypassArmedAt: Date | null;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   @OneToMany(() => PipelinePromotionBlocker, (blocker) => blocker.promotion)
   blockers: PipelinePromotionBlocker[];
}
