import { Inject, Injectable, Logger } from "@nestjs/common";
import argon2 from "argon2";
import path from "path";
import { AuthService } from "../auth/auth.service";
import { FilesService } from "../files/files.service";
import { LoggerToDb } from "../logging";
import { User } from "../models/user";
import { SoftException } from "../util";
import fs from "fs";
import { UploadedFile } from "../models/uploadedFile";
import { ProfileCropData, ProfileStats } from "./user-profile-types";
import sharp from "sharp";
import { FileAccessStat } from "../models/stats/fileAccessStat";
import { SearchStat } from "../models/stats/searchStat";
import { DataSource, In, Repository } from "typeorm";
import { DirectoriesService } from "../directories/directories.service";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

@Injectable()
export class UserProfileService {
	constructor(
		private readonly userService: AuthService,
		private readonly fileService: FilesService,
		private readonly directoryService: DirectoriesService,
		@InjectRepository(User) private readonly userRepo: Repository<User>,
		@InjectRepository(FileAccessStat) private readonly fileAccessStatRepo: Repository<FileAccessStat>,
		@InjectRepository(SearchStat) private readonly searchStatRepo: Repository<SearchStat>,
		@InjectRepository(UploadedFile) private readonly uploadedFileRepo: Repository<UploadedFile>,
		@Inject() private readonly logger: LoggerToDb,
	) {}

	public async changePassword(
		userId: number,
		old_password: string,
		new_password: string
	) {
		// Get the old password of the user
		const user = await this.verifyPassword(userId, old_password);
		user.password = await argon2.hash(new_password);
		this.userRepo.save(user);

		this.logger.log("User changed their password");
	}

	public async changeName(userId: number, password: string, new_name: string) {
		const user = await this.verifyPassword(userId, password);
		user.name = new_name;
		this.userRepo.save(user);
	}

	public async changePicture(
		userId: number,
		password: string,
		file: Express.Multer.File,
		crop: ProfileCropData
	) {
		const user = await this.verifyPassword(userId, password);
		this.saveProfilePicture(user, file, crop);
	}

	public async getStats(userId: number, withDeleted: boolean = false) {
		const fileAccesMeta = this.fileAccessStatRepo.metadata;
		const uploadedFileMeta = this.uploadedFileRepo.metadata;
		const userTbMeta = this.userRepo.metadata;

		const most_accesed_files_raw = await this.fileAccessStatRepo.query(`
			SELECT SUM(T.count) AS Total, U.*
			FROM ${fileAccesMeta.tableName} AS T
			LEFT JOIN ${uploadedFileMeta.tableName} AS U ON T.${uploadedFileMeta.name}Id = U.id
			WHERE T.${userTbMeta.name}Id = $1
					${withDeleted ? "" : " AND T.deleted_at is null"}
			GROUP BY U.id
			ORDER BY Total DESC
			LIMIT 6 	-- Needed to ignore the profile picture access
		`, [userId]);

		const most_search_raw = await this.searchStatRepo.createQueryBuilder("search")
			.addSelect("count(search.text) AS Total")
			.where(`search.${userTbMeta.name}Id = :id`, {id: userId})
			.groupBy("search.text")
			.orderBy("Total", "DESC")
			.limit(5)
			.getRawAndEntities();

		const most_accesed_files: ProfileStats = {
			most_accesed_files: most_accesed_files_raw.map(({ Total, ...file }) => ({
				access_count: Total,
				file,
			})),
			most_searched: most_search_raw.raw.map((e, i) => ({
				search_count: e.Total,
				search: most_search_raw.entities[i],
			})),
			used_data: await this.fileService.getUsedData(userId),
		};

		return most_accesed_files;
	}

	public async indexFiles(userId: number) {
		const user = await this.userService.getById(userId);

		// Get current indexed files
		const currentIndexedFiles = await this.uploadedFileRepo.find({ where: { user: {id: userId} } });

		// Re-index all files
		const files = await this.directoryService.listrecursive(user.id);
		const newIndexedFiles: UploadedFile[] = [];
		for (const file of files) {
			const newFile = new UploadedFile();
			newFile.user = user;
			newFile.absolute_path = file;

			let mime: string =
				currentIndexedFiles.find(
					(e) => path.normalize(e.absolute_path) == path.normalize(file)
				)?.mime ??
				(FilesService.detectFile(
					await this.fileService.absolutePath(userId, file)
				));

			newFile.mime = mime;
			newIndexedFiles.push(await this.uploadedFileRepo.save(newFile));
		}

		// Get all references to the uploaded files (can't delete yet because of foreign key constraints)
		const fileAccessStats = await FileAccessStat.find({
			where: {
				uploaded_file: { id: In(currentIndexedFiles.map((e) => e.id)) },
			},
			relations: ["uploaded_file"],
		});
		for (const fileAccessStat of fileAccessStats) {
			const uploaded_file_new: UploadedFile | undefined = newIndexedFiles.find(
				(e) =>
					path.normalize(e.absolute_path) ==
					path.normalize(fileAccessStat.uploaded_file.absolute_path)
			);

			// If a new uploaded file was not found then this means
			// that the file does not physically exist anymore
			// In that case we have 2 options:
			// 1. Delete the file access stat
			// 2. Soft delete the old Uploaded file reference
			if (!uploaded_file_new) {
				// Decided to go with Removing the file access stat
				await this.fileAccessStatRepo.remove(fileAccessStat);
			} else {
				fileAccessStat.uploaded_file = uploaded_file_new;
				await this.fileAccessStatRepo.save(fileAccessStat);
			}
		}

		// Clear previous indexed files
		await UploadedFile.remove(currentIndexedFiles);

		return newIndexedFiles.length;
	}

	private async verifyPassword(
		userId: number,
		password: string
	): Promise<User> | never {
		const user = await this.userService.getWithPassword(userId);
		if (!(await argon2.verify(user.password, password))) {
			throw new SoftException("Invalid password");
		}

		return user;
	}

	private async saveProfilePicture(
		user: User,
		file: Express.Multer.File,
		crop: ProfileCropData
	) {
		// Create metadata folder
		this.fileService.createMetaFolderIfNotExists(user.id);
		const userId = user.id;

		try {
			const root = await this.fileService.getUserRootPath(userId);
			const dir = await this.fileService.absolutePath(
				userId,
				FilesService.METADATA_FOLDER_NAME + "/prof"
			);
			const relative = path.relative(root, dir);

			if (crop == undefined) {
				fs.writeFileSync(dir, file.buffer);
			} else {
				const image = sharp(file.buffer);
				const metadata = await image.metadata();
				const resizedImg = await image
					.extract({
						top: Math.floor((crop.y / 100) * metadata.height),
						left: Math.floor((crop.x / 100) * metadata.width),
						width: Math.floor((crop.width / 100) * metadata.width),
						height: Math.floor((crop.height / 100) * metadata.height),
					})
					.toBuffer();
				fs.writeFileSync(dir, resizedImg);
			}

			// Remove previous metadata prof indexed file
			await this.uploadedFileRepo.delete({ user: user, absolute_path: relative });

			const fileDB = new UploadedFile();
			fileDB.absolute_path = relative;
			fileDB.user = user;
			fileDB.mime = file.mimetype;
			this.uploadedFileRepo.save(fileDB);

			return [true, ""];
		} catch (e) {
			return [false, (<Error>e).message];
		}
	}
}
