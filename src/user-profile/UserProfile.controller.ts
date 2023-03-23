import {
	Body,
	Controller,
	Get,
	Patch,
	Query,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	ValidationPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express/multer";
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { errorWrapper } from "src/logging";
import { AuthUser } from "src/util";
import {
	ChangeNameRequest,
	ChangePasswordRequest,
	ChangePictureRequest,
	ProfileStats,
} from "./user-profile-types";
import { UserProfileService } from "./UserProfile.service";

@Controller("profile")
@UseGuards(AuthGuard("jwt"))
@ApiTags("User profile settings")
export class UserProfileController {
	constructor(private readonly profileService: UserProfileService) {}

	@Patch("change/password")
	@ApiResponse({ type: OperationStatusResponse })
	public async changePassword(
		@AuthUser() userId: number,
		@Body() body: ChangePasswordRequest
	) {
		return await errorWrapper(
			async () => {
				await this.profileService.changePassword(
					userId,
					body.old_password,
					body.new_password
				);
			},
			UserProfileController,
			userId
		);
	}

	@Patch("change/name")
	@ApiResponse({ type: OperationStatusResponse })
	public async changeName(
		@AuthUser() userId: number,
		@Body() body: ChangeNameRequest
	) {
		return await errorWrapper(
			async () => {
				await this.profileService.changeName(
					userId,
					body.password,
					body.new_name
				);
			},
			UserProfileController,
			userId
		);
	}

	@Patch("change/picture")
	@UseInterceptors(FileInterceptor("file"))
	@ApiResponse({ type: OperationStatusResponse })
	public async changePicture(
		@AuthUser() userId: number,
		@UploadedFile() file: Express.Multer.File,
		@Body() body: ChangePictureRequest
	) {
		return await errorWrapper(
			async () => {
				await this.profileService.changePicture(
					userId,
					body.password,
					file,
					body.crop && body.crop != "undefined"
						? JSON.parse(body.crop as string)
						: undefined
				);
			},
			UserProfileController,
			userId
		);
	}

	@Get("stats")
	@ApiQuery({ name: "with_deleted", required: false })
	@ApiResponse({ type: ProfileStats })
	public async getStats(
		@AuthUser() userId: number,
		@Query("with_deleted", new ValidationPipe({ transform: true }))
		with_deleted: boolean = false
	) {
		return await errorWrapper(
			async () => {
				return await this.profileService.getStats(userId, with_deleted);
			},
			UserProfileController,
			userId
		);
	}

	@Patch("indexfiles")
	@ApiResponse({ type: OperationStatusResponse })
	public async indexFiles(@AuthUser() userId: number) {
		return {
			reindexCount: await this.profileService.indexFiles(userId),
		};
	}
}
