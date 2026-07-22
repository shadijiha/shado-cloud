import { MigrationInterface, QueryRunner } from "typeorm";

export class hehexd1647821495360 implements MigrationInterface {
   name = "hehexd1647821495360";

   public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(
         `CREATE TABLE \`encrypted_password\` (\`id\` int NOT NULL AUTO_INCREMENT, \`username\` varchar(255) NOT NULL, \`website\` varchar(255) NOT NULL, \`encryption_key\` varchar(255) NOT NULL, \`password\` varchar(255) NOT NULL, \`password_length\` int NOT NULL, \`iv\` varchar(255) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`userId\` int NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
      );
      await queryRunner.query(
         `ALTER TABLE \`encrypted_password\` ADD CONSTRAINT \`FK_bda049c99a2b1af761d9301f13b\` FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`,
      );
   }

   public async down(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(`ALTER TABLE \`encrypted_password\` DROP FOREIGN KEY \`FK_bda049c99a2b1af761d9301f13b\``);
      await queryRunner.query(`DROP TABLE \`encrypted_password\``);
   }
}
