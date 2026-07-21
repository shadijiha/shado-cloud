import { MigrationInterface, QueryRunner } from "typeorm";

export class addPropagateToReplicas1721530000000 implements MigrationInterface {
   name = "addPropagateToReplicas1721530000000";

   public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(
         `ALTER TABLE \`deployment_project\` ADD \`propagateToReplicas\` tinyint NOT NULL DEFAULT 0`,
      );
   }

   public async down(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(
         `ALTER TABLE \`deployment_project\` DROP COLUMN \`propagateToReplicas\``,
      );
   }
}
