import {
   Body,
   Controller,
   Post,
   Put,
   Res,
   UseGuards,
   UsePipes,
   Headers,
   Inject,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { DirectoriesService } from "./../directories/directories.service";
import { LoggerToDb } from "./../logging";
import { isDev } from "./../util";
import { AuthService } from "./auth.service";
import { LoginRequest, RegisterRequest } from "./authApiTypes";
import { ValidationPipeline } from "./ValidationPipeline";
import { IncomingHttpHeaders } from "http";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthClientService } from "src/auth-client/auth-client.service";

@Controller("auth")
@ApiTags("Authentication")
export class AuthController {
   static readonly AUTH_EXPIRY_DAYS = 180;
   constructor(
      private readonly authService: AuthService,
      private readonly authClient: AuthClientService,
      private readonly directoryService: DirectoriesService,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {}

   @Post("login")
   @UsePipes(new ValidationPipeline())
   async login(@Headers() headers: IncomingHttpHeaders, @Body() body: LoginRequest, @Res() response: Response) {
      const result = await this.authClient.login(body.email, body.password);

      if (result.error) {
         return response.send({ user: null, errors: [{ field: "email", message: result.error }] });
      }

      // Ensure local user record exists for file/directory relations
      let localUser = await this.authService.getByEmail(body.email);
      if (!localUser) {
         localUser = await this.authService.new(result.name || result.email, result.email, body.password);
         await this.directoryService.createNewUserDir(localUser);
      }

      await this.setAuthCookie(headers, result, response);
   }

   @Post("register")
   @UsePipes(new ValidationPipeline())
   async register(@Headers() headers: IncomingHttpHeaders, @Body() body: RegisterRequest, @Res() response: Response) {
      const result = await this.authClient.register(body.email, body.password, body.name);

      if (result.error) {
         return response.send({ user: null, errors: [{ field: "email", message: result.error }] });
      }

      const localUser = await this.authService.new(body.name, body.email, body.password);
      await this.directoryService.createNewUserDir(localUser);

      await this.setAuthCookie(headers, result, response);
   }

   @Put("logout")
   async logout(@Headers() headers: IncomingHttpHeaders, @Res() response: Response) {
      response
         .clearCookie(this.config.get("COOKIE_NAME"), {
            httpOnly: true,
            domain: this.getDomain(headers),
         })
         .send();
   }

   private async setAuthCookie(
      headers: IncomingHttpHeaders,
      authUser: { id: string; email: string; tokenVersion?: number },
      response: Response,
   ) {
      const { token } = await this.authClient.sign(authUser.id, authUser.email, authUser.tokenVersion);

      response
         .cookie(this.config.get("COOKIE_NAME"), token, {
            httpOnly: true,
            domain: this.getDomain(headers),
            expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * AuthController.AUTH_EXPIRY_DAYS),
            secure: isDev(this.config) ? false : headers.origin?.startsWith("https"),
            sameSite: isDev(this.config) ? "lax" : "none",
         })
         .send({ user: authUser, errors: [] });
   }

   private getDomain(headers: IncomingHttpHeaders): string {
      let domain = headers.host;
      if (domain.includes(":")) domain = domain.split(":")[0];
      const parts = domain.split(".");
      if (parts.length > 2) domain = parts.slice(-2).join(".");
      return domain;
   }
}
