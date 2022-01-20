import { Injectable } from "@nestjs/common";
import { Log } from "src/models/log";

@Injectable()
export class AdminService {
	public async all() {
		return await (
			await Log.find({ relations: ["user"] })
		).sort((a, b) => {
			return b.created_at.getDate() - a.created_at.getDate();
		});
	}
}
