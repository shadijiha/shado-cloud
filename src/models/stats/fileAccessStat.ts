import { ApiProperty } from '@nestjs/swagger'
import {
  BaseEntity,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm'
import { UploadedFile } from '../uploadedFile'
import { User } from '../user'

@Entity({ name: 'file_access_stats' })
export class FileAccessStat extends BaseEntity {
  @PrimaryGeneratedColumn()
    id: number

  @ManyToOne(() => UploadedFile)
  @JoinColumn()
  @Index({ unique: false })
  @ApiProperty({ type: () => UploadedFile })
    uploaded_file: UploadedFile

  @Column()
  @ApiProperty()
    count: number

  @Column()
  @ApiProperty()
    user_agent: string

  @ManyToOne(() => User)
  @Index()
  @ApiProperty({ type: () => User })
    user: User

  @CreateDateColumn()
  @ApiProperty()
    created_at: Date

  @UpdateDateColumn()
  @ApiProperty()
    updated_at: Date

  @DeleteDateColumn()
    deleted_at: Date
}
