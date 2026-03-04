import { Module } from "@nestjs/common";
import { PasswordsVaultController } from "./PasswordsVault.controller";
import { PasswordsVaultService } from "./PasswordsVaultService.service";
import { UserProfileController } from "./UserProfile.controller";
import { UserProfileService } from "./UserProfile.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EncryptedPassword } from "./../models/EncryptedPassword";
import { AuthModule } from "src/auth/auth.module";
import { StorageClientModule } from "../storage/storage-client.module";

@Module({
   imports: [TypeOrmModule.forFeature([EncryptedPassword]), AuthModule, StorageClientModule],
   controllers: [UserProfileController, PasswordsVaultController],
   providers: [UserProfileService, PasswordsVaultService],
})
export class UserProfileModule {}
