import { Injectable, Logger } from "@nestjs/common";
import argon2 from "argon2";
import { AuthService } from "src/auth/auth.service";
import { infoLog } from "src/logging";
import { User } from "src/models/user";
import { SoftException } from "src/util";
import { getConnection, getManager, getRepository } from "typeorm";

@Injectable()
export class UserProfileService {
	constructor(private readonly userService: AuthService) {}

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
}
