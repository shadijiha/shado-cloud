import { MigrationInterface, QueryRunner } from "typeorm";

export class Hehexd1735117543835 implements MigrationInterface {
    name = 'Hehexd1735117543835'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`log\` ADD \`stack\` longtext NULL`);
        await queryRunner.query(`ALTER TABLE \`log\` DROP COLUMN \`message\``);
        await queryRunner.query(`ALTER TABLE \`log\` ADD \`message\` longtext NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`log\` DROP COLUMN \`message\``);
        await queryRunner.query(`ALTER TABLE \`log\` ADD \`message\` varchar(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`log\` DROP COLUMN \`stack\``);
    }

}
