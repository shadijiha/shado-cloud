import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class ServiceFunction {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "longtext" })
    code: string;

    @Column({ type: "longtext", nullable: true })
    last_execution_logs: string | null;

    @Column()
    user_id: number;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}