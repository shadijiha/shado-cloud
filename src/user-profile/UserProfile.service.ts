import { Injectable, Logger } from "@nestjs/common";
import argon2 from "argon2";
import path from "path";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { infoLog } from "src/logging";
import { User } from "src/models/user";
import { SoftException } from "src/util";
import fs from "fs";
import { UploadedFile } from "src/models/uploadedFile";
import { ProfileCropData } from "./user-profile-types";
import sharp from "sharp";

@Injectable()
export class UserProfileService {
	constructor(
		private readonly userService: AuthService,
		private readonly fileService: FilesService
	) {}

	public async changePassword(
		userId: number,
		old_password: string,
		new_password: string
	) {
		// Get the old password of the user
		const user = await this.verifyPassword(userId, old_password);
		user.password = await argon2.hash(new_password);
		user.save();

		infoLog(
			new Error("User changed their password"),
			UserProfileService,
			userId
		);
	}

	public async changeName(userId: number, password: string, new_name: string) {
		const user = await this.verifyPassword(userId, password);
		user.name = new_name;
		user.save();
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
}
