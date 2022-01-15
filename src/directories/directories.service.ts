import { Injectable, Logger } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import fs from "fs";
import { DirectoryInfo } from "./directoriesApiTypes";
import { FileInfo } from "src/files/filesApiTypes";
import path from "path";

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

			if (a.name > b.name) return 1;
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

	public parent(_path: string) {
		if (_path) {
			return path.join(_path, "..");
		} else {
			return "";
		}
	}
}
