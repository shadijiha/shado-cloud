import { ApiProperty } from "@nestjs/swagger";
import {
	BaseEntity,
	Column,
	CreateDateColumn,
	Entity,
	OneToMany,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";
import { Log } from "./log";
import { PasswordsVault } from "./PasswordsVault";
import { TempUrl } from "./tempUrl";
import { UploadedFile } from "./uploadedFile";

@Entity()
export class User extends BaseEntity {
	@ApiProperty()
	@PrimaryGeneratedColumn()
	id: number;

	@ApiProperty()
	@Column({ unique: true })
	email: string;

	@ApiProperty()
	@Column()
	name: string;

	@Column({ select: false })
	password: string;

	@OneToMany(() => UploadedFile, (file) => file.user)
	files: UploadedFile[];

	@OneToMany(() => TempUrl, (url) => url.user)
	temp_urls: TempUrl[];

	@OneToMany(() => Log, (log) => log.user)
	logs: Log[];

	@OneToMany(() => PasswordsVault, (pass) => pass.user)
	vault: PasswordsVault[];

	@ApiProperty()
	@Column({ default: false })
	is_admin: boolean;

	@ApiProperty()
	@CreateDateColumn()
	created_at: Date;

	@ApiProperty()
	@UpdateDateColumn()
	updated_at: Date;
}
