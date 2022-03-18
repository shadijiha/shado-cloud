import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { errorWrapper } from "src/logging";
import { PasswordsVault } from "src/models/PasswordsVault";
import { AuthUser } from "src/util";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import {
	AddToVaultRequest,
	PasswordsVaultAllResponse,
} from "./user-profile-types";

@Controller("profile/vault")
@UseGuards(AuthGuard("jwt"))
@ApiTags("User profile settings")
export class PasswordsVaultController {
	constructor(private readonly passwordVaultService: PasswordsVaultService) {}

	@Get("all")
	@ApiResponse({ type: PasswordsVaultAllResponse })
	public async all(@AuthUser() userId: number) {
		return await errorWrapper(
			async () => {
				return await this.passwordVaultService.all();
			},
			PasswordsVaultController,
			userId
		);
	}

	@Get("get/:encryption_id")
	@ApiResponse({ type: typeof { decrypted_password: "" } })
	public async get(
		@AuthUser() userId: number,
		@Param("encryption_id") encryption_id: number
	) {
		return await errorWrapper(
			async () => {
				return await this.passwordVaultService.get(userId, encryption_id);
			},
			PasswordsVaultController,
			userId
		);
	}

	@Post("add")
	@ApiResponse({ type: PasswordsVault })
	public async add(
		@AuthUser() userId: number,
		@Body() body: AddToVaultRequest
	) {
		return await errorWrapper(
			async () => {
				const result: PasswordsVault[] = [];
				for (const data of body.elements) {
					result.push(
						await this.passwordVaultService.add(
							userId,
							data.username,
							data.password_to_encrypt
						)
					);
				}
				return result;
			},
			PasswordsVaultController,
			userId
		);
	}

	@Delete("delete/:encryption_id")
	@ApiResponse({ type: OperationStatusResponse })
	public async delete(
		@AuthUser() userId: number,
		@Param("encryption_id") encryption_id: number
	) {
		return await errorWrapper(
			async () => {
				await this.passwordVaultService.delete(userId, encryption_id);
			},
			PasswordsVaultController,
			userId
		);
	}
}
