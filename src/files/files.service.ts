import { HttpException, Injectable, Logger } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import fs, { createReadStream } from "fs";
import path from "path";
import { UploadedFile } from "src/models/uploadedFile";
import { FileInfo, FileInfoResponse, OperationStatus } from "./filesApiTypes";
import mmmagic from "mmmagic";
import { TempUrl } from "src/models/tempUrl";

type FileServiceResult = Promise<[boolean, string]>;

@Injectable()
export class FilesService {
	constructor(private userService: AuthService) {}

	public async asStream(userId: number, relativePath: string) {
		const dir = await this.absolutePath(userId, relativePath);
		return createReadStream(dir);
	}

	public async upload(
		userId: number,
		file: Express.Multer.File,
		dest: string
	): FileServiceResult {
		const dir = await this.absolutePath(
			userId,
			path.join(dest, file.originalname)
		);

		try {
			fs.writeFileSync(dir, file.buffer);

			const fileDB = new UploadedFile();
			fileDB.absolute_path = dir;
			fileDB.user = await this.userService.getById(userId);
			fileDB.mime = file.mimetype;
			fileDB.save();

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async new(userId: number, name: string): FileServiceResult {
		const dir = path.join(await this.getUserRootPath(userId), name);

		try {
			fs.writeFileSync(dir, "");

			// Register file in DB
			const file = new UploadedFile();
			file.user = await this.userService.getById(userId);
			file.absolute_path = dir;
			file.mime = "text/plain";
			file.save();

			return [true, ""];
		} catch (e) {
			const err = <Error>e;
			return [false, err.message];
		}
	}

	public async save(
		userId: number,
		fileRelativePath: string,
		content: string,
		append: boolean = false
	): FileServiceResult {
		const dir = await this.absolutePath(userId, fileRelativePath);

		Logger.debug(dir);
		try {
			if (append) {
				fs.appendFileSync(dir, content);
			} else {
				fs.writeFileSync(dir, content);
			}

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async delete(userId: number, relativePath: string): FileServiceResult {
		const dir = await this.absolutePath(userId, relativePath);

		try {
			fs.unlinkSync(dir);

			// See if file is in DB, if yes, then delete it
			const user = await this.userService.getById(userId);
			await UploadedFile.delete({ absolute_path: dir, user });

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async rename(
		userId: number,
		name: string,
		newName: string
	): FileServiceResult {
		const dir = await this.absolutePath(userId, name);
		const newDir = await this.absolutePath(userId, newName);

		try {
			fs.renameSync(dir, newDir);

			// Rename file in DB
			const file = await UploadedFile.findOne({
				where: { absolute_path: dir },
			});
			if (file) {
				file.absolute_path = newDir;
				file.save();
			}

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async info(userId: number, relativePath: string) {
		const dir = await this.absolutePath(userId, relativePath);

		const stats = fs.statSync(dir);
		const file = await UploadedFile.findOne({
			where: { absolute_path: dir },
		});

		const mime = file ? file.mime : await this.detectFile(dir);

		// Get temp url if exists and is active
		const user = await this.userService.getById(userId);
		const tempUrls = await TempUrl.find({ where: { user, filepath: dir } });

		return {
			extension: path.extname(relativePath),
			mime: mime,
			path: path.relative(await this.getUserRootPath(userId), dir),
			name: path.basename(dir),
			is_image: mime.includes("image"),
			is_text: mime.includes("text") || mime == "application/x-empty",
			is_video: mime.includes("video"),
			is_audio: mime.includes("audio"),
			is_pdf: mime.includes("pdf"),
			size: stats.size,
			temp_url:
				tempUrls.length > 0 ? tempUrls.filter((e) => e.isValid())[0] : null,
		};
	}

	public async getUserRootPath(userId: number): Promise<string> {
		// Get user
		const user = await this.userService.getById(userId);
		if (!user)
			throw new HttpException(
				{
					errors: [{ field: "", message: "Invalid user Id" }],
				},
				400
			);

		return path.join(process.env.CLOUD_DIR, user.email);
	}

	public async absolutePath(userId: number, relativePath: string) {
		return path.join(await this.getUserRootPath(userId), relativePath);
	}

	private detectFile(filename: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const magic = new mmmagic.Magic(mmmagic.MAGIC_MIME_TYPE);
			magic.detectFile(filename, function (err, result) {
				if (err) reject(err);
				resolve(result);
			});
		});
	}
}
