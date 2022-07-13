import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { EncryptedPassword } from "src/models/EncryptedPassword";
import { PasswordsVaultController } from "./PasswordsVault.controller";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import { UserProfileController } from "./UserProfile.controller";
import { UserProfileService } from "./UserProfile.service";

@Module({
	controllers: [UserProfileController, PasswordsVaultController],
	providers: [
		UserProfileService,
		PasswordsVaultService,
		AuthService,
		FilesService,
	],
})
export class UserProfileModule {}
