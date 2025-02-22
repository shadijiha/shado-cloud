import { BaseEntity, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

export enum FeatureFlagNamespace {
   Log = "log",
   Files = "files",
   Admin = "admin",
   Replication = "replication",
}

@Entity()
export class FeatureFlag extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   @Column({ type: "enum", enum: FeatureFlagNamespace })
   namespace: FeatureFlagNamespace;

   // Unique key for the feature flag
   // Example: "disabled_log_context"
   @Column({ unique: true })
   key: string;

   // JSON stringified payload
   @Column({ type: "text", nullable: true })
   payload: string | null = "{}";

   @Column({ type: "text", nullable: true })
   description: string | null;

   // Number of times the feature flag has been triggered while cached in redis
   @Column({ default: 0 })
   cached_trigger_count: number;

   // Number of times the feature flag has been triggered while fetched from the database
   @Column({ default: 0 })
   db_trigger_count: number;

   @Column()
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;
}
