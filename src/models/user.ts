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
import { EncryptedPassword } from "./EncryptedPassword";
import { TempUrl } from "./tempUrl";
import { UploadedFile } from "./uploadedFile";
import { SearchStat } from "./stats/searchStat";

// Local record for shado-cloud DB relations.
// Authentication & profile (name, password, is_admin) are owned by shado-auth-api's ShadoUser.
@Entity()
export class User extends BaseEntity {
   @ApiProperty()
   @PrimaryGeneratedColumn()
   id: number;

   @ApiProperty({ description: "UUID from shado-auth-api ShadoUser" })
   @Column({ unique: true })
   shadoUserId: string;

   @OneToMany(() => UploadedFile, (file) => file.user)
   files: UploadedFile[];

   @OneToMany(() => TempUrl, (url) => url.user)
   temp_urls: TempUrl[];

   @OneToMany(() => Log, (log) => log.user)
   logs: Log[];

   @OneToMany(() => EncryptedPassword, (pass) => pass.user)
   encrypted_passwords: EncryptedPassword[];

   @ApiProperty()
   @CreateDateColumn()
   created_at: Date;

   @ApiProperty()
   @UpdateDateColumn()
   updated_at: Date;

   /**
    * @returns Returns the maximum allowed data a user can store on Shado Cloud in bytes
    */
   public getMaxData(): number {
      return 5 * 1024 * 1024 * 1024; // 5 GB
   }
}
