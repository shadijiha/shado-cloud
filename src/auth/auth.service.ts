import { Injectable, Logger } from "@nestjs/common";
import { User } from "src/models/user";
import { getConnection } from "typeorm";
const argon2 = require("argon2");

@Injectable()
export class AuthService {
	public async getByEmail(email: string): Promise<User | null> {
		return await User.findOne({ where: { email } });
	}

	public async new(name: string, email: string, password: string) {
		const user = new User();
		user.email = email;
		user.password = await argon2.hash(password);
		user.name = name;
		return await user.save();
	}

	public async getById(userId: number) {
		return User.findOne({ where: { id: userId } });
	}

	public async passwordMatch(userId: number, password: string) {
		const query = getConnection().createQueryBuilder();
		const user = await query
			.select("user.password")
			.from(User, "user")
			.where("id = :id", {
				id: userId,
			})
			.getOne();
		return argon2.verify(user.password, password);
	}
}
