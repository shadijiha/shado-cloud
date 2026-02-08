import { MigrationInterface, QueryRunner } from "typeorm";

export class hehexd1672633958388 implements MigrationInterface {
   name = "hehexd.1672633958388";

   public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(
         `CREATE FULLTEXT INDEX \`IDX_ab90e4e195dfb1fb09b3cb3e99\` ON \`uploaded_file\` (\`absolute_path\`)`,
      );
   }

   public async down(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`DROP INDEX \`IDX_ab90e4e195dfb1fb09b3cb3e99\` ON \`uploaded_file\``);
   }
}
