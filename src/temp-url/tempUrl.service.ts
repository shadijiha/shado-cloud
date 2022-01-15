import { Injectable } from "@nestjs/common";
import { createReadStream } from "fs";
import path from "path";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { TempUrl } from "src/models/tempUrl";
import { User } from "src/models/user";

@Injectable()
export class TempUrlService {
	constructor(
		private readonly fileService: FilesService,
		private readonly userService: AuthService
	) {}

	public async generate(
		userId: number,
		filepath: string,
		max_requests: number,
		expires_at: Date,
		backendUrl: string
	): Promise<string> {
		const dir = await this.fileService.absolutePath(userId, filepath);

		const tempUrl = new TempUrl();
		tempUrl.user = await this.userService.getById(userId);
		tempUrl.url = this.makeUrl();
		tempUrl.max_requests = max_requests;
		tempUrl.expires_at = expires_at;
		tempUrl.filepath = dir;
		tempUrl.save();

		return backendUrl + "/temp/" + tempUrl.url + "/get";
	}

	public async asStream(tempUrl: string) {
		// Get temp url
		const temp = await TempUrl.findOne({ where: { url: tempUrl } });
		if (!temp) {
			throw new Error("Invalid temporary URL");
		}

		if (!this.verifyUrlConditions(temp)) {
			throw new Error(
				"Max requests exhausted OR temporary URL expired OR url is readonly"
			);
		}

		temp.requests += 1;
		temp.save();

		const dir = temp.filepath;
		return {
			stream: createReadStream(dir),
			filename: path.basename(temp.filepath),
		};
	}

	public async all(userId: number) {
		const user = await this.userService.getById(userId);
		return (await TempUrl.find({ where: { user } })).map((e) => {
			return {
				...e,
				is_valid: e.isValid(),
			};
		});
	}

	public async delete(userId: number, key: any) {
		const user = await this.userService.getById(userId);
		const tempUrl = await TempUrl.findOne({
			where: { url: key },
			relations: ["user"],
		});

		if (!tempUrl) {
			throw new Error("Invalid temporary URL " + tempUrl.url);
		}

		// Check if user owns temp url
		if (user.id != tempUrl.user.id) {
			throw new Error("Cannot delete a temprary URL you don't own");
		}

		// Otherwise delete
		TempUrl.delete(tempUrl.id);
	}

	private verifyUrlConditions(tempUrl: TempUrl, readAndWrite: boolean = false) {
		return (
			tempUrl.requests < tempUrl.max_requests &&
			(readAndWrite ? !tempUrl.is_readonly : true) &&
			new Date() < tempUrl.expires_at
		);
	}

	private makeUrl(length = 32) {
		var result = "";
		var characters =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		var charactersLength = characters.length;
		for (var i = 0; i < length; i++) {
			result += characters.charAt(Math.floor(Math.random() * charactersLength));
		}
		return result;
	}
}
