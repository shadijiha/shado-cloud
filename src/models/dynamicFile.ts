import path from "path";
import { ApiProperty } from "@nestjs/swagger";
import {
   BaseEntity,
   Column,
   CreateDateColumn,
   Entity,
   Index,
   PrimaryGeneratedColumn,
   UpdateDateColumn,
} from "typeorm";

@Entity()
export class DynamicFileEntity extends BaseEntity {
   @PrimaryGeneratedColumn("uuid")
   @ApiProperty()
   id: string; // Used to identify files in the cold drives

   @Column()
   @Index()
   @ApiProperty()
   path: string; // File original path

   @Column()
   @ApiProperty()
   driveName: string;

   @CreateDateColumn()
   @ApiProperty()
   createdAt: Date;

   @UpdateDateColumn()
   @ApiProperty()
   updatedAt: Date;

   public get extension() {
      return path.extname(this.path);
   }

   public belongTo(dir: string) {
      const normalizedFile = path.normalize(this.path);
      const normalizedDir = path.normalize(dir) + path.sep;
      return normalizedFile.startsWith(normalizedDir);
   }
}
