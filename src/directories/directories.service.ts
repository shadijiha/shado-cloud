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
import { ProtectedDirectory } from "src/models/ProtectedDirectory";
import argon2 from "argon2";
import { SoftException } from "src/util";

@Injectable()
export class DirectoriesService {
	constructor(
		private readonly userService: AuthService,
		private readonly fileService: FilesService
	) {}

	public async root(userId: number) {
		return await this.fileService.getUserRootPath(userId);
	}

	public async list(userId: number, relativePath: string, password?: string) {
		await this.verifyDirPassword(userId, relativePath, password);

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
					is_protected: await this.fileService.isProtected(
						userId,
						relativePath
					),
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

		this.fileService.verifyFileName(dir);

		fs.mkdirSync(dir, { recursive: true });
	}

	public async delete(userId: number, relativePath: string, password?: string) {
		await this.verifyDirPassword(userId, relativePath, password);

		const dir = await this.fileService.absolutePath(userId, relativePath);
		fs.rmdirSync(dir, { recursive: true });
	}

	public async rename(
		userId: number,
		name: string,
		newName: string,
		password?: string
	) {
		await this.verifyDirPassword(userId, name, password);

		const dir = await this.fileService.absolutePath(userId, name);
		const newDir = await this.fileService.absolutePath(userId, newName);
		this.fileService.verifyFileName(newDir);
		fs.renameSync(dir, newDir);

		const protectedDir = await this.fileService.getProtectDirObj(userId, name);
		if (protectedDir != null) {
			protectedDir.absolute_path = newDir;
			protectedDir.save();
		}
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

		if (await this.fileService.isProtected(userId, name))
			throw new Error(`Unable to zip ${name} because it is protected!`);

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

	public async protect(
		userId: number,
		relative_path: string,
		password: string
	) {
		if (await this.fileService.isProtected(userId, relative_path))
			throw new Error(`Directory "${relative_path}" already protected`);

		const user = await this.userService.getById(userId);
		if (!user) throw new Error(`Invalid user!`);

		const dir = new ProtectedDirectory();
		dir.user = user;
		dir.absolute_path = await this.fileService.absolutePath(
			userId,
			relative_path
		);
		dir.password = await argon2.hash(password);
		dir.save();
	}

	public async unprotect(
		userId: number,
		relative_path: string,
		password: string
	) {
		if (!this.fileService.isProtected(userId, relative_path))
			throw new Error(`Directory "${relative_path}" is not protected`);

		const user = await this.userService.getById(userId);
		if (!user) throw new Error(`Invalid user!`);

		const dir = await ProtectedDirectory.findOne({
			where: {
				absolute_path: await this.fileService.absolutePath(
					userId,
					relative_path
				),
				user: { id: userId },
			},
		});

		if (await argon2.verify(dir.password, password)) {
			ProtectedDirectory.delete(dir);
		} else {
			throw new Error("Invalid password");
		}
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

	private async verifyDirPassword(
		userId: number,
		relativePath: string,
		password?: string
	) {
		if (await this.fileService.isProtected(userId, relativePath)) {
			const dir = await this.fileService.getProtectDirObj(userId, relativePath);

			if (!(await argon2.verify(dir.password, password ?? "")))
				throw new SoftException("Wrong password for " + relativePath);
		}
	}
}
