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
   Headers,
   Inject,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { Response, Request } from "express";
import { DirectoriesService } from "./../directories/directories.service";
import { FilesService } from "./../files/files.service";
import { LoggerToDb } from "./../logging";
import { User } from "./../models/user";
import { AuthUser } from "./../util";
import { AuthService } from "./auth.service";
import { LoginRequest, LoginResponse, RegisterRequest } from "./authApiTypes";
import { ValidationPipeline } from "./ValidationPipeline";
import { IncomingHttpHeaders } from "http";
import { isDev } from "./../app.module";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

@Controller("auth")
@ApiTags("Authentication")
export class AuthController {
   constructor(
      private readonly jwtService: JwtService,
      private readonly authService: AuthService,
      private readonly directoryService: DirectoriesService,
      private readonly fileService: FilesService,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {}

   @Post("login")
   @UsePipes(new ValidationPipeline())
   @ApiResponse({ type: LoginResponse })
   async login(@Headers() headers: IncomingHttpHeaders, @Body() body: LoginRequest, @Res() response: Response) {
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
      const passwordResult = await this.authService.passwordMatch(user.id, body.password);

      if (!passwordResult) {
         response.send({
            user: null,
            errors: [{ field: "password", message: "Invalid credentials" }],
         });
         return;
      }

      // Otherwise OK
      this.createAuthCookie(headers, user, response);
   }

   @Post("register")
   @UsePipes(new ValidationPipeline())
   @ApiResponse({ type: LoginResponse })
   async register(@Headers() headers: IncomingHttpHeaders, @Body() body: RegisterRequest, @Res() response: Response) {
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
      this.createAuthCookie(headers, user, response);
   }

   @Put("logout")
   async logout(@Headers() headers: IncomingHttpHeaders, @Res() response: Response) {
      response
         .clearCookie(this.config.get("COOKIE_NAME"), {
            httpOnly: true,
            domain: this.getDomain(headers), // your domain here!
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
         this.logger.logException(e);
         return null;
      }
   }

   private async createAuthCookie(headers: IncomingHttpHeaders, user: User, response: Response) {
      const userId = user.id;
      const payload = { userId };
      const token = this.jwtService.sign(payload);

      response
         .cookie(this.config.get("COOKIE_NAME"), token, {
            httpOnly: true,
            domain: this.getDomain(headers), // your domain here!
            expires: new Date(Date.now() + 1000 * 60 * 60 * 24),
            secure: isDev(this.config) ? false : headers.origin.startsWith("https"),
            sameSite: isDev(this.config) ? "lax" : "none",
         })
         .send({
            user: {
               ...user,
               profPic: await this.fileService.profilePictureInfo(userId),
            },
            errors: [],
         });
   }

   private getDomain(headers: IncomingHttpHeaders): string {
      let domain = headers.host;
      // Remove post number
      if (domain.includes(":")) {
         domain = domain.split(":")[0];
      }
      return domain;
   }
}
