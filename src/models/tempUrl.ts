import { ApiProperty } from '@nestjs/swagger'
import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm'
import { User } from './user'

@Entity()
export class TempUrl extends BaseEntity {
  @PrimaryGeneratedColumn()
  @ApiProperty()
    id: number

  // @ApiProperty({ type: () => User })
  @ManyToOne(() => User, (user) => user.temp_urls)
    user: User

  @Column()
  @ApiProperty()
    url: string

  @Column()
  @ApiProperty()
    filepath: string

  @Column({ default: 0 })
  @ApiProperty()
    requests: number

  @Column()
  @ApiProperty()
    max_requests: number

  @Column({ default: true })
  @ApiProperty()
    is_readonly: boolean

  @Column()
  @ApiProperty()
    expires_at: Date

  @CreateDateColumn()
  @ApiProperty()
    created_at: Date

  @UpdateDateColumn()
  @ApiProperty()
    updated_at: Date

  @ApiProperty({ type: Boolean, name: 'is_valid' })
  public isValid (): boolean {
    return this.requests < this.max_requests && new Date() < this.expires_at
  }
}
