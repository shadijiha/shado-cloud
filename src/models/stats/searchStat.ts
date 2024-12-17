import { ApiProperty } from '@nestjs/swagger'
import { BaseEntity, Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { User } from '../user'

@Entity({ name: 'search_stats' })
export class SearchStat extends BaseEntity {
  @PrimaryGeneratedColumn()
  @ApiProperty()
    id: number

  @Column()
  @ApiProperty()
    text: string

  @ManyToOne(() => User)
  @ApiProperty({ type: () => User })
    user: User

  @CreateDateColumn()
  @ApiProperty()
    created_at: Date
}
