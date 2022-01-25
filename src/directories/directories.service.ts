import { Injectable, Logger } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import fs from "fs";
import { DirectoryInfo } from "./directoriesApiTypes";
import { FileInfo } from "src/files/filesApiTypes";
import path from "path";
import { User } from "src/models/user";
import archiver from "archiver";
import extract from "extract-zip";
import { errorLog } from "src/logging";

@Injectable()
export class DirectoriesService {
	constructor(
		private userService: AuthService,
		private readonly fileService: FilesService
	) {}

	public async root(userId: number) {
		return await this.fileService.getUserRootPath(userId);
	}

	public async list(userId: number, relativePath: string) {
		const dir = await this.fileService.absolutePath(userId, relativePath);
		const files = fs.readdirSync(dir, { withFileTypes: true });
		const result: (DirectoryInfo | FileInfo)[] = [];

		for (const file of files) {
			if (file.isDirectory()) {
				result.push({
					name: file.name,
					path: path.relative(
						await this.fileService.getUserRootPath(userId),
						dir
					),
					is_dir: true,
				});
			} else {
				result.push(
					await this.fileService.info(
						userId,
						path.join(relativePath, file.name)
					)
				);
			}
		}

		return result.sort((a: DirectoryInfo, b: DirectoryInfo) => {
			if (a.is_dir != b.is_dir) {
				return a.is_dir ? -1 : 1;
			}

			if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
			else return -1;
		});
	}

	public async new(userId: number, name: string) {
		const dir = await this.fileService.absolutePath(userId, name);
		fs.mkdirSync(dir, { recursive: true });
	}

	public async delete(userId: number, relativePath: string) {
		const dir = await this.fileService.absolutePath(userId, relativePath);
		fs.rmdirSync(dir, { recursive: true });
	}

	public async rename(userId: number, name: string, newName: string) {
		const dir = await this.fileService.absolutePath(userId, name);
		const newDir = await this.fileService.absolutePath(userId, newName);
		fs.renameSync(dir, newDir);
	}

	public async createNewUserDir(user: User) {
		if (!fs.existsSync(path.join(process.env.CLOUD_DIR, user.email)))
			fs.mkdirSync(path.join(process.env.CLOUD_DIR, user.email));
	}

	public async listrecursive(userId: number) {
		const dir = await this.fileService.getUserRootPath(userId);
		const files = this.getAllFiles(dir);

		return files
			.map((filedata) => {
				return path.relative(dir, filedata.path);
			})
			.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	}

	public async zip(userId: number, name: string) {
		const dir = await this.fileService.absolutePath(userId, name);

		if (!fs.lstatSync(dir).isDirectory()) {
			throw new Error("FIle to zip must be a directory");
		}

		const output = fs.createWriteStream(dir + ".zip");
		const archive = archiver("zip");

		archive.on("error", function (err) {
			errorLog(err, DirectoriesService, userId);
		});
		archive.pipe(output);
		archive.directory(dir, false);
		archive.finalize();
	}

	public async unzip(userId: number, name: string) {
		const dir = await this.fileService.absolutePath(userId, name);
		const fileFullName = path.basename(dir);
		const fileName = path.parse(fileFullName).name;
		const dirPath = path.dirname(dir);
		const outputPath = path.join(dirPath, fileName);

		await extract(dir, { dir: outputPath });
	}

	public parent(_path: string) {
		if (_path) {
			return path.join(_path, "..");
		} else {
			return "";
		}
	}

	private getAllFiles(path: string) {
		const entries = fs.readdirSync(path, { withFileTypes: true });

		// Get files within the current directory and add a path key to the file objects
		const files = entries
			.filter((file) => !file.isDirectory())
			.map((file) => ({ ...file, path: path + "/" + file.name }));

		// Get folders within the current directory
		const folders = entries.filter((folder) => folder.isDirectory());

		/*
			  Add the found files within the subdirectory to the files array by calling the
			  current function itself
			*/

		for (const folder of folders) {
			files.push(...this.getAllFiles(`${path}/${folder.name}/`));
		}

		return files;
	}
}
