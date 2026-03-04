import { Test, type TestingModule } from "@nestjs/testing";
import { AuthController } from "src/auth/auth.controller";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "src/auth/auth.service";
import { LoggerToDb } from "src/logging";
import { type Response } from "express";
import { type IncomingHttpHeaders } from "http";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { ValidationPipe } from "@nestjs/common";
import { StorageClient } from "src/storage/storage.client";

jest.mock("argon2");
jest.mock("sharp", () => {
   return jest.fn().mockImplementation(() => {
      return {
         resize: jest.fn().mockReturnThis(),
         toBuffer: jest.fn().mockResolvedValue(Buffer.from("mocked image data")),
      };
   });
});

describe("AuthController", () => {
   let authController: AuthController;
   let authService: AuthService;
   let storage: StorageClient;
   let jwtService: JwtService;
   let logger: LoggerToDb;
   let response: Response;
   let config: ConfigService<Pick<EnvVariables, "COOKIE_NAME">>;

   beforeEach(async () => {
      const mockJwtService = { sign: jest.fn().mockReturnValue("mocked-jwt-token") };
      const mockAuthService = {
         getByEmail: jest.fn(),
         passwordMatch: jest.fn(),
         new: jest.fn(),
         getById: jest.fn(),
      };
      const mockStorageClient = {
         dirCreateUserDir: jest.fn().mockResolvedValue({ success: true }),
         profilePictureInfo: jest.fn().mockResolvedValue("mocked-prof-pic"),
      };
      const mockLoggerToDb = { logException: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         controllers: [AuthController],
         providers: [
            { provide: JwtService, useValue: mockJwtService },
            { provide: AuthService, useValue: mockAuthService },
            { provide: StorageClient, useValue: mockStorageClient },
            { provide: LoggerToDb, useValue: mockLoggerToDb },
            {
               provide: ConfigService,
               useValue: {
                  get: jest
                     .fn()
                     .mockImplementation((key: string) => (key == "COOKIE_NAME" ? "shado_cloud_prod" : null)),
               },
            },
         ],
      })
         .overrideProvider(ValidationPipe)
         .useValue(
            new ValidationPipe({
               whitelist: false,
               forbidNonWhitelisted: false,
               transform: false,
               skipMissingProperties: true,
            }),
         )
         .compile();

      authController = module.get<AuthController>(AuthController);
      authService = module.get<AuthService>(AuthService);
      storage = module.get<StorageClient>(StorageClient);
      jwtService = module.get<JwtService>(JwtService);
      logger = module.get<LoggerToDb>(LoggerToDb);
      config = module.get<ConfigService>(ConfigService);

      response = {
         send: jest.fn(),
         cookie: jest.fn().mockReturnThis(),
         clearCookie: jest.fn().mockReturnThis(),
      } as any;
   });

   it("should be defined", () => {
      expect(authController).toBeDefined();
   });

   describe("login", () => {
      it("should login successfully and return a JWT token", async () => {
         let cookieWasSet = false;
         const responseOverride = {
            send: jest.fn(),
            cookie: jest.fn().mockImplementation(() => {
               cookieWasSet = true;
               return response;
            }),
            clearCookie: jest.fn().mockReturnThis(),
         } as any;

         const body = { email: "test@example.com", password: "password123" };
         const mockUser = { id: 1, email: body.email, password: "hashedPassword" };

         authService.getByEmail = jest.fn().mockResolvedValue(mockUser);
         authService.passwordMatch = jest.fn().mockResolvedValue(true);

         const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
         await authController.login(headers, body, responseOverride);

         expect(authService.getByEmail).toHaveBeenCalledWith(body.email);
         expect(authService.passwordMatch).toHaveBeenCalledWith(mockUser.id, body.password);
         expect(jwtService.sign).toHaveBeenCalled();
         expect(responseOverride.cookie).toHaveBeenCalledWith(
            config.get("COOKIE_NAME"),
            "mocked-jwt-token",
            expect.any(Object),
         );
         expect(cookieWasSet).toBeTruthy();
      });

      it("should return an error if the email is invalid", async () => {
         const body = { email: "invalid@example.com", password: "password123" };
         authService.getByEmail = jest.fn().mockResolvedValue(null);

         const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
         await authController.login(headers, body, response);

         expect(response.send).toHaveBeenCalledWith({
            user: null,
            errors: [{ field: "email", message: "Invalid email" }],
         });
      });

      it("should return an error if the password is invalid", async () => {
         const body = { email: "test@example.com", password: "wrongPassword" };
         const mockUser = { id: 1, email: body.email, password: "hashedPassword" };

         authService.getByEmail = jest.fn().mockResolvedValue(mockUser);
         authService.passwordMatch = jest.fn().mockResolvedValue(false);

         const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
         await authController.login(headers, body, response);

         expect(response.send).toHaveBeenCalledWith({
            user: null,
            errors: [{ field: "password", message: "Invalid credentials" }],
         });
      });
   });

   describe("register", () => {
      it("should register a user successfully", async () => {
         let cookieWasSet = false;
         const response = {
            send: jest.fn(),
            cookie: jest.fn().mockImplementation(() => {
               cookieWasSet = true;
               return response;
            }),
            clearCookie: jest.fn().mockReturnThis(),
         } as any;

         const body = { name: "New User", email: "new@example.com", password: "password123" };
         const mockUser = { id: 1, email: body.email, name: body.name, password: "hashedPassword" };

         authService.getByEmail = jest.fn().mockResolvedValue(null);
         authService.new = jest.fn().mockResolvedValue(mockUser);

         const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
         await authController.register(headers, body, response);

         expect(authService.getByEmail).toHaveBeenCalledWith(body.email);
         expect(authService.new).toHaveBeenCalledWith(body.name, body.email, body.password);
         expect(storage.dirCreateUserDir).toHaveBeenCalledWith(mockUser.email);
         expect(response.cookie).toHaveBeenCalledWith(
            config.get("COOKIE_NAME"),
            "mocked-jwt-token",
            expect.any(Object),
         );
         expect(cookieWasSet).toBeTruthy();
      });

      it("should return an error if the email is already taken", async () => {
         const body = { name: "Existing User", email: "taken@example.com", password: "password123" };
         const mockUser = { id: 1, email: body.email, name: body.name, password: "hashedPassword" };

         authService.getByEmail = jest.fn().mockResolvedValue(mockUser);

         const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
         await authController.register(headers, body, response);

         expect(response.send).toHaveBeenCalledWith({
            user: null,
            errors: [{ field: "email", message: "email is taken" }],
         });
      });
   });

   describe("logout", () => {
      it("should clear the cookie and send a response", async () => {
         const headers = { host: "localhost" };
         await authController.logout(headers as any, response);

         expect(response.clearCookie).toHaveBeenCalledWith(config.get("COOKIE_NAME"), {
            httpOnly: true,
            domain: "localhost",
         });
         expect(response.send).toHaveBeenCalled();
      });
   });

   describe("me", () => {
      it("should return the authenticated user information", async () => {
         const userId = 1;
         const mockUser = { id: userId, name: "Test User", email: "test@example.com" };

         authService.getById = jest.fn().mockResolvedValue(mockUser);

         const result = await authController.me(userId);

         expect(result).toEqual({ ...mockUser, profPic: "mocked-prof-pic" });
         expect(authService.getById).toHaveBeenCalledWith(userId);
         expect(storage.profilePictureInfo).toHaveBeenCalledWith(userId);
      });
   });
});
