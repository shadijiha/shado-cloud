import { ApiProperty } from "@nestjs/swagger";
import {
	BaseEntity,
	Column,
	CreateDateColumn,
	Entity,
	Index,
	JoinColumn,
	ManyToOne,
	OneToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";
import { UploadedFile } from "../uploadedFile";
import { User } from "../user";

@Entity({ name: "file_access_stats" })
export class FileAccessStat extends BaseEntity {
	@PrimaryGeneratedColumn()
	id: number;

	@OneToOne(() => UploadedFile)
	@JoinColumn()
	@Index()
	@ApiProperty({ type: () => UploadedFile })
	uploaded_file: UploadedFile;

	@Column()
	@ApiProperty()
	count: number;

	@ManyToOne(() => User)
	@Index()
	@ApiProperty({ type: () => User })
	user: User;

	@CreateDateColumn()
	@ApiProperty()
	created_at: Date;

	@UpdateDateColumn()
	@ApiProperty()
	updated_at: Date;
}
