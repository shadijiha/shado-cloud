import { Injectable } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { EncryptedPassword } from "src/models/EncryptedPassword";
import { User } from "src/models/user";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import { SoftException } from "src/util";
import { getConnection, Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import {
	FilterOperator,
	paginate,
	Paginated,
	PaginateQuery,
} from "nestjs-paginate";

@Injectable()
export class PasswordsVaultService {
	public constructor(
		private readonly userService: AuthService,
		@InjectRepository(EncryptedPassword)
		private readonly catsRepository: Repository<EncryptedPassword>
	) {}

	public async all(
		userId: number,
		query: PaginateQuery
	): Promise<Paginated<EncryptedPassword>> {
		return paginate<EncryptedPassword>(query, this.catsRepository, {
			relations: ["user"],
			sortableColumns: ["website", "username", "id"],
			searchableColumns: ["id", "username", "website"],
			where: { user: { id: userId } },
		});
	}

	public async add(
		userId: number,
		username: string,
		website: string,
		passwordToStore: string
	) {
		const user = await this.userService.getWithPassword(userId);
		if (!user) {
			throw new Error("User " + userId + " not found");
		}

		// Encrypt
		return await this.encrypt(
			username,
			new URL(website),
			passwordToStore,
			user
		);
	}

	public async get(
		userId: number,
		encryption_id: number
	): Promise<{ decrypted_password: string }> {
		const decrypt = await this.decrypt(userId, encryption_id);

		return {
			decrypted_password: decrypt.decryptedPassword,
		};
	}

	public async delete(userId: number, encryption_id: number) {
		const query = getConnection().createQueryBuilder();
		const vault = await query
			.select("vault.encryption_key")
			.addSelect("vault.iv")
			.addSelect("vault.password")
			.addSelect("vault")
			.addSelect("vault.userId")
			.from(EncryptedPassword, "vault")
			.leftJoinAndSelect("vault.user", "user")
			.where("vault.id = :encryption_id", {
				encryption_id,
			})
			.getOne();

		if (!vault) {
			throw new SoftException("Invalid Password vault ID " + encryption_id);
		}

		// Check if has permission to delete this password
		if (userId != vault.user.id) {
			throw new SoftException(
				"You don't have permission to access this password"
			);
		}

		EncryptedPassword.delete(vault.id);
	}

	/**
	 * Generates an encryption and stores it in the database
	 * @param text
	 * @param user
	 */
	private async encrypt(
		username: string,
		website: URL,
		passwordToStore: string,
		user: User
	) {
		if (!user.password) {
			throw new Error(
				"To encrypt text you need to select user's password from DB"
			);
		}

		const iv = randomBytes(16);
		const password = user.password;

		// The key length is dependent on the algorithm.
		// In this case for aes256, it is 32 bytes.
		const key = (await promisify(scrypt)(
			password,
			process.env.PASSWORD_VAULT_SALT,
			32
		)) as Buffer;
		const cipher = createCipheriv("aes-256-ctr", key, iv);
		const encryptedText = Buffer.concat([
			cipher.update(passwordToStore),
			cipher.final(),
		]);

		// Store in DB
		const passwordVault = new EncryptedPassword();
		passwordVault.iv = iv.toString("hex");
		passwordVault.encryption_key = key.toString("hex");
		passwordVault.password = encryptedText.toString("hex");
		passwordVault.password_length = passwordToStore.length;
		passwordVault.username = username;
		passwordVault.user = user;
		passwordVault.website = website.origin;
		passwordVault.save();

		delete passwordVault.user.password;

		return passwordVault;
	}

	private async decrypt(
		userId: number,
		encryptionId: number
	): Promise<{ vault: EncryptedPassword; decryptedPassword: string }> {
		const query = getConnection().createQueryBuilder();
		const vault = await query
			.select("vault.encryption_key")
			.addSelect("vault.iv")
			.addSelect("vault.password")
			.addSelect("vault")
			.addSelect("vault.userId")
			.from(EncryptedPassword, "vault")
			.leftJoinAndSelect("vault.user", "user")
			.where("vault.id = :encryptionId", {
				encryptionId,
			})
			.getOne();

		if (!vault) {
			throw new SoftException("Invalid Password vault ID " + encryptionId);
		}

		// Check if has permission to acces this password
		if (userId != vault.user.id) {
			throw new SoftException(
				"You don't have permission to access this password"
			);
		}

		//  Decrypt
		const key = Buffer.from(vault.encryption_key, "hex");
		const iv = Buffer.from(vault.iv, "hex");
		const encryptedText = Buffer.from(vault.password, "hex");

		const decipher = createDecipheriv("aes-256-ctr", key, iv);
		const decryptedText = Buffer.concat([
			decipher.update(encryptedText),
			decipher.final(),
		]);

		return {
			vault,
			decryptedPassword: decryptedText.toString(),
		};
	}
}
