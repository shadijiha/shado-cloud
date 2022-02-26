import { HttpException, Injectable, Logger } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import fs, { createReadStream } from "fs";
import path from "path";
import { UploadedFile } from "src/models/uploadedFile";
import mmmagic from "mmmagic";
import { TempUrl } from "src/models/tempUrl";
import sharp from "sharp";
import ThumbnailGenerator from "fs-thumbnail";
import { SoftException } from "src/util";
type FileServiceResult = Promise<[boolean, string]>;

@Injectable()
export class FilesService {
	constructor(private userService: AuthService) {}

	public async asStream(userId: number, relativePath: string, options?: any) {
		const dir = await this.absolutePath(userId, relativePath);
		if (!fs.existsSync(dir)) throw new Error(dir + " does not exist");

		return createReadStream(dir, options);
	}

	public async upload(
		userId: number,
		file: Express.Multer.File,
		dest: string
	): FileServiceResult {
		try {
			const cleanName = path.join(
				dest,
				this.replaceIllegalChars(file.originalname)
			);
			const root = await this.getUserRootPath(userId);
			const dir = await this.absolutePath(userId, cleanName);
			const relative = path.relative(root, dir);

			fs.writeFileSync(dir, file.buffer);

			const fileDB = new UploadedFile();
			fileDB.absolute_path = relative;
			fileDB.user = await this.userService.getById(userId);
			fileDB.mime = file.mimetype;
			fileDB.save();

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async new(userId: number, name: string): Promise<void> | never {
		const root = await this.getUserRootPath(userId);
		const dir = path.join(root, name);
		const relative = path.relative(root, dir);

		this.verifyFileName(dir);

		fs.writeFileSync(dir, "");

		// Register file in DB
		const file = new UploadedFile();
		file.user = await this.userService.getById(userId);
		file.absolute_path = relative;
		file.mime = "text/plain";
		file.save();
	}

	public async save(
		userId: number,
		fileRelativePath: string,
		content: string,
		append: boolean = false
	): FileServiceResult {
		try {
			const dir = await this.absolutePath(userId, fileRelativePath);
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
		try {
			const root = await this.getUserRootPath(userId);
			const dir = await this.absolutePath(userId, relativePath);
			const relative = path.relative(root, dir);
			fs.unlinkSync(dir);

			// See if file is in DB, if yes, then delete it
			const user = await this.userService.getById(userId);
			await UploadedFile.delete({ absolute_path: relative, user });

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}

	public async rename(
		userId: number,
		name: string,
		newName: string
	): Promise<void> | never {
		const root = await this.getUserRootPath(userId);
		const dir = await this.absolutePath(userId, name);
		const newDir = await this.absolutePath(userId, newName);
		const relative = path.relative(root, dir);
		const relativeNew = path.relative(root, newDir);

		this.verifyFileName(newDir);

		fs.renameSync(dir, newDir);

		// Rename file in DB
		const user = await this.userService.getById(userId);
		const file = await UploadedFile.findOne({
			where: { absolute_path: relative, user },
		});

		if (file) {
			file.absolute_path = relativeNew;
			file.save();
		} else {
			// Else if it is not in DB then insert it
			const mime = await this.detectFile(newDir);

			const uploadedFile = new UploadedFile();
			uploadedFile.user = user;
			uploadedFile.absolute_path = relativeNew;
			uploadedFile.mime = mime;
			uploadedFile.save();
		}
	}

	public async info(userId: number, relativePath: string) {
		const root = await this.getUserRootPath(userId);
		const dir = await this.absolutePath(userId, relativePath);
		const relative = path.relative(root, dir);

		const stats = fs.statSync(dir);
		const file = await UploadedFile.findOne({
			where: { absolute_path: relative },
		});

		const mime = file ? file.mime : await this.detectFile(dir);

		// Get temp url if exists and is active
		const user = await this.userService.getById(userId);
		const tempUrls = await TempUrl.find({
			where: { user, filepath: relative },
		});

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

	public async toThumbnail(
		path_: string,
		userId: number,
		width: number | undefined = undefined,
		height: number | undefined = undefined
	) {
		const dir = await this.absolutePath(userId, path_);
		const mime = await this.detectFile(dir);

		if (mime.includes("image")) {
			if (!fs.existsSync(dir)) throw new Error(dir + " does not exist");

			const resized = sharp()
				.resize(Number(width) || undefined, Number(height) || undefined)
				.withMetadata();

			return fs.createReadStream(dir).pipe(resized);
		} else {
			// If it is a video generate thumbnail
			const thumbnailPath = path.join(
				path.dirname(dir),
				".videometa." + path.basename(dir) + ".png"
			);

			const thumbGen = new ThumbnailGenerator({
				verbose: false, // Whether to print out warning/errors
				size: [width ?? "?", height ?? "?"], // Default size, either a single number of an array of two numbers - [width, height].
				quality: 70, // Default quality, between 1 and 100
			});

			await thumbGen.getThumbnail({
				path: dir,
				output: thumbnailPath,
			});

			// Delete that thumbnail after 1 second (request sent)
			setTimeout(() => {
				fs.unlinkSync(thumbnailPath);
			}, 1000);

			return fs.createReadStream(thumbnailPath);
		}
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

	public verifyFileName(fullpath: string) {
		// Verify that the user is not creating a hidden folder
		const basename = path.basename(fullpath);
		if (basename.startsWith("."))
			throw new SoftException("Directory/File name cannot start with '.'");

		// Check for illegal chars
		const illegal = [
			"?",
			"!",
			"[",
			"]",
			"{",
			"}",
			"/",
			"\\",
			"*",
			"<",
			">",
			"|",
			'"',
			"'",
			":",
			"@",
		];
		for (const c of illegal) {
			if (basename.includes(c))
				throw new SoftException("Directory/File name cannot contain " + c);
		}
	}

	private replaceIllegalChars(filename: string) {
		// Verify that the user is not creating a hidden folder
		let basename = path.basename(filename);
		while (basename.startsWith(".")) {
			basename = basename.substring(1);
		}

		// Check for illegal chars
		const illegal = [
			"?",
			"!",
			"[",
			"]",
			"{",
			"}",
			"/",
			"\\",
			"*",
			"<",
			">",
			"|",
			'"',
			"'",
			"@",
			":",
		];
		for (const c of illegal) {
			basename = basename.replace(new RegExp(`\\${c}`, "g"), "");
		}

		// Check if the name is empty after replacing stuff
		if (basename == "")
			basename = new Date().toLocaleDateString().replace(":", "-");

		return basename;
	}
}
