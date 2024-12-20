import { Module } from "@nestjs/common";
import { PasswordsVaultController } from "./PasswordsVault.controller";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import { UserProfileController } from "./UserProfile.controller";
import { UserProfileService } from "./UserProfile.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EncryptedPassword } from "./../models/EncryptedPassword";
import { AuthModule } from "src/auth/auth.module";
import { FilesModule } from "src/files/files.module";
import { DirectoriesModule } from "src/directories/directories.module";

@Module({
   imports: [TypeOrmModule.forFeature([EncryptedPassword]), AuthModule, FilesModule, DirectoriesModule],
   controllers: [UserProfileController, PasswordsVaultController],
   providers: [UserProfileService, PasswordsVaultService],
})
export class UserProfileModule {}
