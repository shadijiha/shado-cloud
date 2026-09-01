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
import { WaveKind } from "./pipeline.types";

/**
 * A wave batches consecutive stages so they can be released as one unit.
 * Rendered as a labelled band spanning the stage columns it contains.
 */
@Entity("pipeline_wave")
export class PipelineWave extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column()
   pipelineId: number;

   @ManyToOne(() => Pipeline, (pipeline) => pipeline.waves, { onDelete: "CASCADE" })
   @JoinColumn({ name: "pipelineId" })
   pipeline: Pipeline;

   @Column()
   name: string;

   @Column({ type: "varchar", length: 32, default: WaveKind.Exclusive })
   kind: WaveKind;

   /** Left-to-right ordering of the wave bands. */
   @Column({ default: 0 })
   position: number;

   /** EXCLUSIVE only: minutes to wait after a member succeeds before the next may start. */
   @Column({ default: 0 })
   bakeTimeMinutes: number;

   /** STAGGERED only: minutes between member start times. */
   @Column({ default: 0 })
   staggerMinutes: number;

   /** Hex accent used for the wave band, e.g. "#0972d3". */
   @Column({ default: "#5f6b7a" })
   accentColor: string;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   @OneToMany(() => PipelineStage, (stage) => stage.wave)
   stages: PipelineStage[];
}
