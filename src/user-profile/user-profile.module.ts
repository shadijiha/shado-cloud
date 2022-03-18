import { Module } from "@nestjs/common";
import { AuthService } from "src/auth/auth.service";
import { PasswordsVaultController } from "./PasswordsVault.controller";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import { UserProfileController } from "./UserProfile.controller";
import { UserProfileService } from "./UserProfile.service";

@Module({
	controllers: [UserProfileController, PasswordsVaultController],
	providers: [UserProfileService, PasswordsVaultService, AuthService],
})
export class UserProfileModule {}
