import { DataSource } from "typeorm";
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";

const filePath = path.resolve(process.cwd(), "config.yml"); // adjust if needed
const file = fs.readFileSync(filePath, "utf8");
const config = yaml.load(file);

console.log("Generating migrations for DB " + config.db.name);

export const connection = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    username: config.db.username,
    password: config.db.password,
    database: config.db.name,
    entities: ["dist/src/models/*{.ts,.js}"],
    migrations: ["dist/migrations/*{.ts,.js}"],
    cli: {
        migrationsDir: "src/migrations",
    },
    migrationsTableName: "cloud_api_migrations",
});
