import { Injectable } from "@nestjs/common";
import { exec, ExecException } from "child_process";
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

	public async redeploy() {
		const result = await cmd("./deploy");
		return { result };
	}
}

// Helper
function cmd(command: string): Promise<ExecException | string> {
	return new Promise((resolve, reject) => {
		exec(command, (err, stdout, stderr) => {
			if (err) {
				return reject(err);
			}

			// the *entire* stdout and stderr (buffered)
			return resolve(stdout);
		});
	});
}
