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
import { Paginate, Paginated, PaginateQuery } from "nestjs-paginate";
import {
	OperationStatus,
	OperationStatusResponse,
} from "src/files/filesApiTypes";
import { errorWrapper } from "src/logging";
import { EncryptedPassword } from "src/models/EncryptedPassword";
import { AuthUser } from "src/util";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import {
	AddToVaultRequest,
	AddToVaultResponse,
	AllPasswordsResponse,
	PasswordsVaultAllResponse,
} from "./user-profile-types";

@Controller("profile/vault")
@UseGuards(AuthGuard("jwt"))
@ApiTags("User profile settings")
export class PasswordsVaultController {
	constructor(private readonly passwordVaultService: PasswordsVaultService) {}

	@Get("all")
	@ApiResponse({ type: AllPasswordsResponse })
	public async all(
		@AuthUser() userId: number,
		@Paginate() query: PaginateQuery
	): Promise<Paginated<EncryptedPassword>> {
		return await errorWrapper(
			async () => {
				return await this.passwordVaultService.all(userId, query);
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
	@ApiResponse({ type: AddToVaultResponse })
	public async add(
		@AuthUser() userId: number,
		@Body() body: AddToVaultRequest
	): Promise<AddToVaultResponse> {
		return await errorWrapper(
			async () => {
				const result: EncryptedPassword[] = [];
				const errors = [];
				for (const data of body.elements) {
					try {
						result.push(
							await this.passwordVaultService.add(
								userId,
								data.username,
								data.website,
								data.password_to_encrypt
							)
						);
					} catch (e) {
						errors.push({ field: "", message: (<Error>e).message });
					}
				}
				return {
					result,
					status: OperationStatus[OperationStatus.SUCCESS],
					errors,
				};
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
