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
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
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
	@ApiQuery({ name: "search", type: String })
	@ApiResponse({ type: AllPasswordsResponse })
	public async all(
		@AuthUser() userId: number,
		@Paginate() query: PaginateQuery
	): Promise<Paginated<EncryptedPassword>> {
		return await errorWrapper(
			async () => {
				const result = await this.passwordVaultService.all(userId, query);

				// Now we need to do this because nest pagination was giving worng url on Pi server
				// Instead of sending full URL to frontend, send relative URL only so frontend can make proper call
				const resolveLink = (e: string) =>
					e ? e.replace(new URL(e).origin, "") : e;
				result.links.current = resolveLink(result.links.current);
				result.links.first = resolveLink(result.links.first);
				result.links.last = resolveLink(result.links.last);
				result.links.next = resolveLink(result.links.next);
				result.links.previous = resolveLink(result.links.previous);

				return result;
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
