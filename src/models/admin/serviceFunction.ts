import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class ServiceFunction {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ nullable: true })
    name: string;

    @Column({ type: "longtext" })
    code: string;

    @Column({ type: "longtext", nullable: true })
    last_execution_logs: string | null;

    /**
     * This column is the service function "storage" or "disk"
     * You can save data of any kind here and retreive it in subsequent executions
     */
    @Column({ type: "longtext", nullable: true })
    storage: string | undefined | null;

    @Column()
    user_id: number;

    @Column({ default: true})
    enabled: boolean;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;

    /**
     * Statistics
     */
    @Column({ default: 0})
    last_execution_time_ms: number;

    @Column({ default: null, nullable: true})
    avg_execution_time_ms: number | null;

    // Total number of times this function has been executed
    @Column({default: 0})
    execution_count: number;
}