import { Body, Controller, Patch, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { errorWrapper } from "src/logging";
import { AuthUser } from "src/util";
import { ChangeNameRequest, ChangePasswordRequest } from "./user-profile-types";
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
}
