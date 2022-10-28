import { ApiProperty } from "@nestjs/swagger";
import {
	BaseEntity,
	Column,
	CreateDateColumn,
	Entity,
	ManyToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";
import { User } from "./user";

@Entity()
export class ProtectedDirectory extends BaseEntity {
	@PrimaryGeneratedColumn()
	@ApiProperty()
	id: number;

	@Column()
	@ApiProperty()
	absolute_path: string;

	@Column()
	password: string;

	@ManyToOne(() => User, (user) => user.protected_dirs)
	@ApiProperty()
	user: User;

	@CreateDateColumn()
	@ApiProperty()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
