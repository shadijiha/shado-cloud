import { DataSource } from "typeorm";
import 'dotenv/config';

export const connection = new DataSource({
    type: process.env.DB_TYPE,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities: ["dist/src/models/*{.ts,.js}"],
    migrations: ["dist/migrations/*{.ts,.js}"],
    cli: {
        migrationsDir: "src/migrations",
    },
});