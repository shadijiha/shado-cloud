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
export class EncryptedPassword extends BaseEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@Column()
	@ApiProperty()
	username: string; // This can be username or email

	@Column()
	@ApiProperty()
	website: string;

	@Column({ select: false })
	encryption_key: string;

	@Column({ select: false })
	password: string;

	@Column()
	@ApiProperty()
	password_length: number;

	@Column({ select: false })
	iv: string;

	@ManyToOne(() => User, (user) => user.encrypted_passwords)
	@ApiProperty({ type: () => User })
	user: User;

	@CreateDateColumn()
	@ApiProperty()
	created_at: Date;

	@UpdateDateColumn()
	@ApiProperty()
	updated_at: Date;
}
