import { Injectable } from "@nestjs/common";
import { Log } from "src/models/log";

@Injectable()
export class AdminService {
	public async all() {
		return await (
			await Log.find({ relations: ["user"] })
		).sort((a, b) => {
			return b.created_at.getTime() - a.created_at.getTime();
		});
	}

	public async deleteByIds(ids: number[]) {
		await Log.delete(ids);
	}
}
