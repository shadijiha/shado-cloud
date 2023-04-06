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
import { FileAccessStat } from "src/models/stats/fileAccessStat";
import { UsedData } from "src/user-profile/user-profile-types";
import { DirectoriesService } from "src/directories/directories.service";
import { infoLog } from "../logging";
type FileServiceResult = Promise<[boolean, string]>;

@Injectable()
export class FilesService {
	public static readonly METADATA_FOLDER_NAME = ".metadata";
	private readonly dirService: DirectoriesService; // Not injected, because it would cause a circular dependency

	constructor(private userService: AuthService) {
		this.dirService = new DirectoriesService(userService, this);

		// Sharp cache
		sharp.cache(true);
		sharp.cache({ memory: 1024, items: 5000, files: 500 });
		sharp.simd(true);
	}

	public async asStream(
		userId: number,
		relativePath: string,
		user_agent: string,
		options?: any
	) {
		const dir = await this.absolutePath(userId, relativePath);
		if (!fs.existsSync(dir)) throw new Error(dir + " does not exist");

		this.updateStats(userId, dir, user_agent);
		const owns = await this.isOwner(userId, dir);

		if (!owns) {
			throw new Error(
				"You don't have permission to access this file " + relativePath
			);
		}

		return createReadStream(dir, options);
	}

	public async upload(
		userId: number,
		file: Express.Multer.File,
		dest: string
	): FileServiceResult {
		try {
			// Check if user has enough space to upload the file
			const usedData = await this.getUsedData(userId);
			const user = await this.userService.getById(userId);

			if (usedData.total() + file.size > (await user.getMaxData())) {
				return [false, "You don't have enough space to upload this file"];
			}

			const cleanName = path.join(
				dest,
				this.replaceIllegalChars(file.originalname)
			);
			const root = await this.getUserRootPath(userId);
			const dir = await this.absolutePath(userId, cleanName);

			const owns = await this.isOwner(userId, dir);
			if (!owns) {
				return [false, "You don't have permission to upload here"];
			}

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

		if (!(await this.isOwner(userId, dir))) {
			throw new Error("You don't have permission to create files here");
		}

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
		append: boolean | string = false
	): FileServiceResult {
		try {
			const dir = await this.absolutePath(userId, fileRelativePath);
			const owns = await this.isOwner(userId, dir);
			if (!owns) {
				return [false, "You don't have permission to save here"];
			}

			if (!append || append == "false") {
				fs.writeFileSync(dir, content);
			} else {
				fs.appendFileSync(dir, content);
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

			if (!(await this.isOwner(userId, dir))) {
				return [false, "You don't have permission to delete this file"];
			}

			const relative = path.relative(root, dir);
			fs.unlinkSync(dir);

			// See if file is in DB, if yes, then delete it
			const user = await this.userService.getById(userId);
			const uploadedFile = await UploadedFile.findOne({
				where: { absolute_path: relative, user },
			});
			const accessData = await FileAccessStat.find({
				where: { uploaded_file: uploadedFile },
			});
			if (accessData) await FileAccessStat.softRemove(accessData);

			if (uploadedFile) await UploadedFile.softRemove(uploadedFile);

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

		if (!(await this.isOwner(userId, dir))) {
			throw new Error("You don't have permission to rename this file");
		}

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
			const mime = await FilesService.detectFile(newDir);

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

		if (!(await this.isOwner(userId, dir))) {
			throw new Error("You don't have permission to access this file");
		}

		const stats = fs.statSync(dir);
		const file = await UploadedFile.findOne({
			where: { absolute_path: relative },
		});

		const mime = file ? file.mime : await FilesService.detectFile(dir);

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

	public async exists(userId: number, relativePath: string) {
		const root = await this.getUserRootPath(userId);
		const dir = await this.absolutePath(userId, relativePath);

		if (!(await this.isOwner(userId, dir))) {
			throw new Error("You don't have permission to access this file");
		}

		return fs.existsSync(dir);
	}

	public async toThumbnail(
		path_: string,
		userId: number,
		width: number | undefined = undefined,
		height: number | undefined = undefined
	) {
		const dir = await this.absolutePath(userId, path_);
		const mime = await FilesService.detectFile(dir);

		if (!(await this.isOwner(userId, dir))) {
			throw new Error("You don't have permission to access this file");
		}

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

	public static detectFile(filename: string): Promise<string> {
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

	public replaceIllegalChars(filename: string) {
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

	public async profilePictureInfo(userId: number) {
		const dir = await this.absolutePath(
			userId,
			FilesService.METADATA_FOLDER_NAME + "/prof"
		);
		return {
			exists: fs.existsSync(dir),
			path: path.relative(await this.getUserRootPath(userId), dir),
		};
	}

	public async getUsedData(userId: number) {
		// TODO: Cache this in redis
		const root = await this.getUserRootPath(userId);
		const user = await this.userService.getById(userId);
		const used_data: UsedData = new UsedData();
		used_data.max = user.getMaxData();

		const arrayOfFiles = await this.dirService.listrecursive(userId);
		arrayOfFiles.forEach((relativePath) => {
			const filePath = path.join(root, relativePath);
			// Get the file extension
			const ext = path.extname(filePath).toLowerCase();
			const size = fs.statSync(filePath).size;

			if (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif")
				used_data.images += size;
			else if (
				ext == ".mp4" ||
				ext == ".webm" ||
				ext == ".mkv" ||
				ext == ".avi" ||
				ext == ".mov" ||
				ext == ".wmv"
			)
				used_data.videos += size;
			else if (
				ext == ".pdf" ||
				ext == ".doc" ||
				ext == ".docx" ||
				ext == ".xls" ||
				ext == ".xlsx" ||
				ext == ".ppt" ||
				ext == ".pptx" ||
				ext == ".odt" ||
				ext == ".ods" ||
				ext == ".odp" ||
				ext == ".txt" ||
				ext == ".rtf"
			)
				used_data.documents += size;
			else used_data.other += size;
		});

		return used_data;
	}

	public async createMetaFolderIfNotExists(userId: number) {
		const dir = await this.absolutePath(
			userId,
			FilesService.METADATA_FOLDER_NAME
		);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	private async updateStats(
		userId: number,
		absolute_path: string,
		user_agent: string
	) {
		const root = await this.getUserRootPath(userId);
		const sanitizedRelative = path.relative(root, absolute_path); // Need this to avoid weird slashes
		const user = await this.userService.getById(userId);

		// Check if file is indexed
		let indexed = await UploadedFile.findOne({
			where: { absolute_path: sanitizedRelative, user: user },
		});

		// If not index then created it
		if (!indexed) {
			indexed = new UploadedFile();
			indexed.absolute_path = sanitizedRelative;
			indexed.user = user;
			indexed.mime = await FilesService.detectFile(absolute_path);
			await indexed.save();
		}

		// Now see if the stat already exists
		let stat = await FileAccessStat.findOne({
			where: { user, uploaded_file: indexed, user_agent },
		});
		if (!stat) {
			stat = new FileAccessStat();
			stat.uploaded_file = indexed;
			stat.user = user;
			stat.count = 0;
			stat.user_agent = user_agent;
			await stat.save();
		}

		stat.count += 1;
		await stat.save();
	}

	public async isOwner(userId: number, absolute_path: string) {
		const root = await this.getUserRootPath(userId);
		const sanitizedRelative = path.relative(absolute_path, root);
		// If we replace all "..\" and there is still and email in the path,
		// then the user is trying to access a file outside of his root
		const res = sanitizedRelative
			.replace(/\.\./g, "")
			.replace(/\\/g, "")
			.replace(/\//g, "");

		const cond = res.length == 0;
		if (!cond) {
			infoLog(
				new Error(
					`Not owner of ${absolute_path}. Sanatized result: ${res}. Sanatized length: ${res.length}`
				),
				this.isOwner,
				userId
			);
		}
		return cond;
	}
}
