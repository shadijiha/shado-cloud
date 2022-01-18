import {
	BaseEntity,
	Column,
	CreateDateColumn,
	Entity,
	ManyToOne,
	PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "./user";

@Entity()
export class Log extends BaseEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	type: "error" | "warn" | "info";

	@Column()
	message: string;

	@Column({ nullable: true })
	route: string;

	@Column()
	controller: string;

	@ManyToOne(() => User, (user) => user.logs)
	user: User;

	@CreateDateColumn()
	created_at: Date;
}
