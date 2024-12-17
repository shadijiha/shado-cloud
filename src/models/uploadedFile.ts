import { ApiProperty } from '@nestjs/swagger'
import {
  BaseEntity,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm'
import { User } from './user'

@Entity()
export class UploadedFile extends BaseEntity {
  @PrimaryGeneratedColumn()
  @ApiProperty()
    id: number

  @Column()
  @Index({ fulltext: true })
  @ApiProperty()
    absolute_path: string

  @ManyToOne(() => User, (user) => user.files)
  @Index()
  @ApiProperty({ type: () => User })
    user: User

  @Column()
  @ApiProperty()
    mime: string

  @CreateDateColumn()
  @ApiProperty()
    created_at: Date

  @UpdateDateColumn()
    updated_at: Date

  @DeleteDateColumn()
    deleted_at: Date
}
