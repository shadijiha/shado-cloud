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
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Response, Request } from "express";
import { use } from "passport";
import { DirectoriesService } from "src/directories/directories.service";
import { User } from "src/models/user";
import { AuthUser } from "src/util";
import { AuthService } from "./auth.service";
import { LoginRequest, LoginResponse, RegisterRequest } from "./authApiTypes";

@Controller("auth")
@ApiTags("Authentication")
export class AuthController {
	constructor(
		private jwtService: JwtService,
		private authService: AuthService,
		private directoryService: DirectoriesService
	) {}

	@Post("login")
	@ApiResponse({ type: LoginResponse })
	async login(
		@Body() body: LoginRequest,
		@Res() response: Response
	): Promise<LoginResponse> {
		// Check if user exists
		const user = await this.authService.getByEmail(body.email);
		if (user == null) {
			return {
				user: null,
				errors: [{ field: "email", message: "Invalid email" }],
			};
		}

		// Check if password maches
		if (!this.authService.passwordMatch(user.id, body.password)) {
			return {
				user: null,
				errors: [{ field: "password", message: "Invalid credentials" }],
			};
		}

		// Otherwise OK
		this.createAuthCookie(user, response);
	}

	@Post("register")
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
				domain: process.env.BACKEND_HOST, // your domain here!
			})
			.send();
	}

	@Get("me")
	@UseGuards(AuthGuard("jwt"))
	@ApiResponse({ type: User })
	async me(@AuthUser() userId: number, @Req() request: Request) {
		return await this.authService.getById(userId);
	}

	private createAuthCookie(user: User, response: Response): void {
		const userId = user.id;
		const payload = { userId: userId };
		const token = this.jwtService.sign(payload);

		response
			.cookie(process.env.COOKIE_NAME, token, {
				httpOnly: true,
				domain: process.env.BACKEND_HOST, // your domain here!
				expires: new Date(Date.now() + 1000 * 60 * 60 * 24),
			})
			.send({ user, errors: [] });
	}
}