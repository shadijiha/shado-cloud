import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   OneToMany,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";
import { PipelineStage } from "./pipelineStage";
import { PipelineWave } from "./pipelineWave";
import { PipelinePromotion } from "./pipelinePromotion";

/**
 * A release pipeline. Owns an ordered set of stages, the promotions that connect
 * them and (optionally) waves that batch stages together.
 */
@Entity("pipeline")
export class Pipeline extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   /** Stable url slug, e.g. "backend". */
   @Column({ unique: true })
   slug: string;

   @Column()
   name: string;

   @Column({ type: "text", nullable: true })
   description: string | null;

   /** Default working directory for every target that does not override it. `__CWD__` = process.cwd(). */
   @Column({ default: "" })
   workDir: string;

   /** Git branch watched by the webhook trigger. */
   @Column({ default: "master" })
   branch: string;

   /**
    * Whether a tag push triggers a run. Release automation commonly pushes an
    * annotated tag (`refs/tags/v3.0.90`) instead of committing to the branch, in
    * which case a branch-only rule would never fire.
    */
   @Column({ default: true })
   triggerOnTags: boolean;

   /** Glob a pushed tag must match to trigger, e.g. `v*`. Empty means any tag. */
   @Column({ default: "" })
   tagPattern: string;

   /** PM2 process name, used by targets flagged `triggersRestart`. */
   @Column({ nullable: true })
   pm2ProcessName: string | null;

   /** Master switch. A disabled pipeline refuses to start runs. */
   @Column({ default: true })
   enabled: boolean;

   /**
    * Andon cord. When set the whole pipeline is held: no automated promotion
    * fires anywhere until it is cleared.
    */
   @Column({ default: false })
   disabled: boolean;

   @Column({ nullable: true })
   disabledBy: string | null;

   @Column({ type: "text", nullable: true })
   disabledMessage: string | null;

   @Column({ type: "datetime", nullable: true })
   disabledAt: Date | null;

   /** Free-form owner label surfaced in the header. */
   @Column({ nullable: true })
   owner: string | null;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   @OneToMany(() => PipelineWave, (wave) => wave.pipeline)
   waves: PipelineWave[];

   @OneToMany(() => PipelineStage, (stage) => stage.pipeline)
   stages: PipelineStage[];

   @OneToMany(() => PipelinePromotion, (promotion) => promotion.pipeline)
   promotions: PipelinePromotion[];
}
