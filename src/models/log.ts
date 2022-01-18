import { ApiProperty } from "@nestjs/swagger";
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
	@ApiProperty()
	id: number;

	@Column()
	@ApiProperty()
	type: "error" | "warn" | "info";

	@Column()
	@ApiProperty()
	message: string;

	@Column({ nullable: true })
	@ApiProperty()
	route: string;

	@Column()
	@ApiProperty()
	controller: string;

	@ManyToOne(() => User, (user) => user.logs)
	@ApiProperty()
	user: User;

	@CreateDateColumn()
	@ApiProperty()
	created_at: Date;
}
