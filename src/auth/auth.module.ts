import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { DirectoriesService } from "src/directories/directories.service";
import { FilesService } from "src/files/files.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthStrategy } from "./auth.strategy";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./../models/user";
import { UploadedFile } from "./../models/uploadedFile";

@Module({
	controllers: [AuthController],
	imports: [
		JwtModule.register({
			secret: process.env.JWT_SECRET,
			signOptions: {
				expiresIn: "24h",
			},
		}),
		TypeOrmModule.forFeature([User, UploadedFile]),
	],
	providers: [AuthStrategy, AuthService, FilesService, DirectoriesService],
	exports: [AuthService, TypeOrmModule.forFeature([User, UploadedFile])],
})
export class AuthModule {}
