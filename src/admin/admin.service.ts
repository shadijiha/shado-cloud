import { Injectable } from "@nestjs/common";
import { Log } from "src/models/log";

@Injectable()
export class AdminService {
	public async all() {
		return await Log.find({ relations: ["user"] });
	}
}
