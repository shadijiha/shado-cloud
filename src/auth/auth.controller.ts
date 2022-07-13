import {
	Body,
	Controller,
	Get,
	Logger,
	Post,
	Put,
	Req,
	Res,
	UseGuards,
	UsePipes,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Response, Request } from "express";
import { use } from "passport";
import { DirectoriesService } from "src/directories/directories.service";
import { FilesService } from "src/files/files.service";
import { errorLog } from "src/logging";
import { User } from "src/models/user";
import { AuthUser } from "src/util";
import { AuthService } from "./auth.service";
import { LoginRequest, LoginResponse, RegisterRequest } from "./authApiTypes";
import { ValidationPipeline } from "./ValidationPipeline";

@Controller("auth")
@ApiTags("Authentication")
export class AuthController {
	constructor(
		private jwtService: JwtService,
		private authService: AuthService,
		private directoryService: DirectoriesService,
		private fileService: FilesService
	) {}

	@Post("login")
	@UsePipes(new ValidationPipeline())
	@ApiResponse({ type: LoginResponse })
	async login(@Body() body: LoginRequest, @Res() response: Response) {
		// Check if user exists
		const user = await this.authService.getByEmail(body.email);
		if (user == null) {
			response.send({
				user: null,
				errors: [{ field: "email", message: "Invalid email" }],
			});
			return;
		}

		// Check if password maches
		const passwordResult = await this.authService.passwordMatch(
			user.id,
			body.password
		);

		if (!passwordResult) {
			response.send({
				user: null,
				errors: [{ field: "password", message: "Invalid credentials" }],
			});
			return;
		}

		// Otherwise OK
		this.createAuthCookie(user, response);
	}

	@Post("register")
	@UsePipes(new ValidationPipeline())
	@ApiResponse({ type: LoginResponse })
	async register(@Body() body: RegisterRequest, @Res() response: Response) {
		// Check if user exists
		let user = await this.authService.getByEmail(body.email);
		if (user) {
			response.send({
				user: null,
				errors: [{ field: "email", message: "email is taken" }],
			});
			return;
		}

		// Create user
		user = await this.authService.new(body.name, body.email, body.password);

		// Create his directory
		await this.directoryService.createNewUserDir(user);

		// Otherwise OK
		this.createAuthCookie(user, response);
	}

	@Put("logout")
	async logout(@Res() response: Response) {
		response
			.clearCookie(process.env.COOKIE_NAME, {
				httpOnly: true,
				domain: process.env.BACKEND_HOST_NAME, // your domain here!
			})
			.send();
	}

	@Get("me")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: User })
	async me(@AuthUser() userId: number, @Req() request: Request) {
		try {
			const user = await this.authService.getById(userId);
			return {
				...user,
				profPic: await this.fileService.profilePictureInfo(userId),
			};
		} catch (e) {
			errorLog(e, AuthController, userId);
			return null;
		}
	}

	private async createAuthCookie(user: User, response: Response) {
		const userId = user.id;
		const payload = { userId: userId };
		const token = this.jwtService.sign(payload);

		response
			.cookie(process.env.COOKIE_NAME, token, {
				httpOnly: true,
				domain: process.env.BACKEND_HOST_NAME, // your domain here!
				expires: new Date(Date.now() + 1000 * 60 * 60 * 24),
			})
			.send({
				user: {
					...user,
					profPic: await this.fileService.profilePictureInfo(userId),
				},
				errors: [],
			});
	}
}
