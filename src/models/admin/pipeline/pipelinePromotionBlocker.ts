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
import { PipelinePromotion } from "./pipelinePromotion";
import { BlockerConfig, BlockerKind, BlockerState } from "./pipeline.types";

/**
 * Something that prevents a promotion from firing: a time window, an alarm, an
 * environment lock, or a manual approval gate. Rendered as an icon badge sitting
 * between the arrow and the destination stage.
 */
@Entity("pipeline_promotion_blocker")
export class PipelinePromotionBlocker extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   promotionId: number;

   @ManyToOne(() => PipelinePromotion, (promotion) => promotion.blockers, { onDelete: "CASCADE" })
   @JoinColumn({ name: "promotionId" })
   promotion: PipelinePromotion;

   @Column({ type: "varchar", length: 32 })
   kind: BlockerKind;

   @Column()
   name: string;

   @Column({ type: "text", nullable: true })
   description: string | null;

   /**
    * JSON-serialised {@link BlockerConfig}, shape depends on `kind`.
    * Nullable because MySQL rejects a DEFAULT on TEXT columns.
    */
   @Column({ type: "text", nullable: true })
   config: string | null;

   /**
    * Last evaluated state. TIME_WINDOW blockers are recomputed on the fly;
    * ALARM/LOCK/MANUAL_APPROVAL blockers persist their state here.
    */
   @Column({ type: "varchar", length: 16, default: BlockerState.Ok })
   state: BlockerState;

   @Column({ type: "datetime", nullable: true })
   lastStateChange: Date | null;

   /** Inactive blockers are kept for history but never block. */
   @Column({ default: true })
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   getConfig<T extends BlockerConfig>(): Partial<T> {
      try {
         const parsed = JSON.parse(this.config ?? "{}");
         return (parsed && typeof parsed === "object" ? parsed : {}) as Partial<T>;
      } catch {
         return {} as Partial<T>;
      }
   }

   setConfig(config: BlockerConfig | Record<string, unknown>) {
      this.config = JSON.stringify(config ?? {});
   }
}
