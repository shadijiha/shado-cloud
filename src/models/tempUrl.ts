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

/**
 * Who is allowed to open a temp-URL share.
 *  - PUBLIC        : anybody with the link (token-only access).
 *  - AUTHENTICATED : any signed-in Shado user (a valid session cookie is required).
 *  - RESTRICTED    : only a specific allow-list of users (FUTURE — not yet selectable
 *                    or enforceable; creating a restricted share is rejected for now).
 */
export enum TempUrlAccessLevel {
   PUBLIC = "public",
   AUTHENTICATED = "authenticated",
   RESTRICTED = "restricted",
}

@Entity()
export class TempUrl extends BaseEntity {
   @PrimaryGeneratedColumn()
   @ApiProperty()
   id: number;

   // @ApiProperty({ type: () => User })
   @ManyToOne(() => User, (user) => user.temp_urls)
   user: User;

   @Column()
   @ApiProperty()
   url: string;

   @Column()
   @ApiProperty()
   filepath: string;

   @Column({ default: 0 })
   @ApiProperty()
   requests: number;

   @Column()
   @ApiProperty()
   max_requests: number;

   @Column({ default: true })
   @ApiProperty()
   is_readonly: boolean;

   // Whether this share points at a directory (browsable in the frontend explorer)
   // rather than a single file. Determined server-side at generation time from the
   // actual filesystem entry, never trusted from the client.
   @Column({ default: false })
   @ApiProperty()
   is_dir: boolean;

   // When true, the share is only accessible to *any* authenticated Shado user
   // (a valid session cookie is required). When false, the token alone grants access.
   @Column({ default: TempUrlAccessLevel.PUBLIC })
   @ApiProperty({ enum: TempUrlAccessLevel })
   access_level: TempUrlAccessLevel;

   @Column()
   @ApiProperty()
   expires_at: Date;

   @CreateDateColumn()
   @ApiProperty()
   created_at: Date;

   @UpdateDateColumn()
   @ApiProperty()
   updated_at: Date;

   @ApiProperty({ type: Boolean, name: "is_valid" })
   public isValid(): boolean {
      return this.requests < this.max_requests && new Date() < this.expires_at;
   }
}
