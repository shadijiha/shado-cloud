import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import { validate } from "./config.validator";

export const CONFIG_FILE_NAME = "config.yml"

export default () => {
    const filePath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
    const file = fs.readFileSync(filePath, "utf8");
    const raw = yaml.load(file);
    return validate(raw);
};