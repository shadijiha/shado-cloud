import { MigrationInterface, QueryRunner } from "typeorm";

export class hehexd1674621069330 implements MigrationInterface {
   name = "hehexd1674621069330";

   public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`ALTER TABLE \`uploaded_file\` ADD \`deleted_at\` datetime(6) NULL`);
   }

   public async down(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`ALTER TABLE \`uploaded_file\` DROP COLUMN \`deleted_at\``);
   }
}
