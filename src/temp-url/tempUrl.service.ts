import { Injectable } from "@nestjs/common";
import { createReadStream, existsSync } from "fs";
import path from "path";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { TempUrl } from "src/models/tempUrl";
import fs from "fs";
import { SoftException } from "src/util";
import { IncomingHttpHeaders } from "http";

@Injectable()
export class TempUrlService {
	constructor(
		private readonly fileService: FilesService,
		private readonly userService: AuthService
	) { }

	public async generate(
		requestHeaders: IncomingHttpHeaders,
		userId: number,
		filepath: string,
		max_requests: number,
		expires_at: Date,
		is_readonly: boolean
	): Promise<string> {
		//const dir = await this.fileService.absolutePath(userId, filepath);

		const tempUrl = new TempUrl();
		tempUrl.user = await this.userService.getById(userId);
		tempUrl.url = this.makeUrl();
		tempUrl.max_requests = max_requests;
		tempUrl.expires_at = expires_at;
		tempUrl.filepath = filepath;
		tempUrl.is_readonly = is_readonly;
		tempUrl.save();

		return requestHeaders.origin + "/temp/" + tempUrl.url + "/get";
	}

	public async asStream(tempUrl: string) {
		// Get temp url
		const temp = await TempUrl.findOne({
			where: { url: tempUrl },
			relations: ["user"],
		});
		if (!temp) {
			throw new SoftException("Invalid temporary URL");
		}

		if (!this.verifyUrlConditions(temp)) {
			throw new SoftException(
				"Max requests exhausted OR temporary URL expired OR url is readonly"
			);
		}

		temp.requests += 1;
		temp.save();

		const dir = await this.fileService.absolutePath(
			temp.user.id,
			temp.filepath
		);

		// Check if file still exists
		if (!existsSync(dir)) {
			throw new SoftException("File referenced by temp URL no longer exists");
		}

		return {
			stream: createReadStream(dir),
			filename: path.basename(temp.filepath),
			info: await this.fileService.info(temp.user.id, temp.filepath),
		};
	}

	public async save(tempUrl: string, content: string, append: boolean = false) {
		// Get temp url
		const temp = await TempUrl.findOne({
			where: { url: tempUrl },
			relations: ["user"],
		});
		if (!temp) {
			throw new SoftException("Invalid temporary URL");
		}

		if (!this.verifyUrlConditions(temp, true)) {
			throw new SoftException(
				"Max requests exhausted OR temporary URL expired OR url is readonly"
			);
		}

		temp.requests += 1;
		temp.save();
		const dir = await this.fileService.absolutePath(
			temp.user.id,
			temp.filepath
		);

		// Check if file still exists
		if (!existsSync(dir)) {
			throw new SoftException("File referenced by temp URL no longer exists");
		}

		if (append) {
			fs.appendFileSync(dir, content);
		} else {
			fs.writeFileSync(dir, content);
		}
	}

	public async all(userId: number) {
		const user = await this.userService.getById(userId);
		return (await TempUrl.find({ where: { user: {id: userId} } })).map((e) => {
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
			throw new SoftException("Invalid temporary URL " + tempUrl.url);
		}

		// Check if user owns temp url
		if (user.id != tempUrl.user.id) {
			throw new SoftException("Cannot delete a temprary URL you don't own");
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
