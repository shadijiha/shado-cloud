import { ApiProperty } from "@nestjs/swagger";
import { BaseEntity, Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "./user";

@Entity()
export class Log extends BaseEntity {
   @PrimaryGeneratedColumn()
   @ApiProperty()
   id: number;

   @Column()
   @ApiProperty()
   type: "error" | "warn" | "info" | "debug";

   @Column({ type: "longtext" })
   @ApiProperty()
   message: string;

   @Column({ nullable: true, type: "longtext" })
   @ApiProperty()
   stack: string;

   @Column({ nullable: true })
   @ApiProperty()
   route: string;

   @Column()
   @ApiProperty()
   controller: string;

   @ManyToOne(() => User, (user) => user.logs)
   @ApiProperty({ type: () => User })
   user: User;

   @Column({ nullable: true })
   @ApiProperty()
   userAgent: string;

   @Column({ nullable: true })
   @ApiProperty()
   ipAddress: string;

   @CreateDateColumn()
   @ApiProperty()
   created_at: Date;
}
