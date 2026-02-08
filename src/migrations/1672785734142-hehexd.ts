import { MigrationInterface, QueryRunner } from "typeorm";

export class hehexd1672785734142 implements MigrationInterface {
   name = "hehexd1672785734142";

   public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`CREATE INDEX \`IDX_e920c0763e417bdcc4b2fd14ac\` ON \`uploaded_file\` (\`userId\`)`);
   }

   public async down(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`DROP INDEX \`IDX_e920c0763e417bdcc4b2fd14ac\` ON \`uploaded_file\``);
   }
}
