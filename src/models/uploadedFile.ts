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
export class UploadedFile extends BaseEntity {
	@PrimaryGeneratedColumn()
	@ApiProperty()
	id: number;

	@Column()
	@ApiProperty()
	absolute_path: string;

	@ManyToOne(() => User, (user) => user.files)
	@ApiProperty()
	user: User;

	@Column()
	@ApiProperty()
	mime: string;

	@CreateDateColumn()
	@ApiProperty()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
