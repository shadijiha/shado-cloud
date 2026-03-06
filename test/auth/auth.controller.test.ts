import { Test, type TestingModule } from "@nestjs/testing";
import { AuthController } from "src/auth/auth.controller";
import { AuthService } from "src/auth/auth.service";
import { DirectoriesService } from "src/directories/directories.service";
import { LoggerToDb } from "src/logging";
import { type Response } from "express";
import { type IncomingHttpHeaders } from "http";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { AuthClientService } from "src/auth-client/auth-client.service";

describe("AuthController", () => {
   let authController: AuthController;
   let authService: AuthService;
   let authClient: AuthClientService;
   let directoriesService: DirectoriesService;
   let response: Response;
   let config: ConfigService<Pick<EnvVariables, "COOKIE_NAME">>;

   beforeEach(async () => {
      const mockAuthService = {
         getByEmail: jest.fn(),
         new: jest.fn(),
         getById: jest.fn(),
      };
      const mockAuthClient = {
         login: jest.fn(),
         register: jest.fn(),
         sign: jest.fn().mockResolvedValue({ token: "mocked-jwt-token" }),
      };
      const mockDirectoriesService = { createNewUserDir: jest.fn() };
      const mockLoggerToDb = { logException: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         controllers: [AuthController],
         providers: [
            { provide: AuthService, useValue: mockAuthService },
            { provide: AuthClientService, useValue: mockAuthClient },
            { provide: DirectoriesService, useValue: mockDirectoriesService },
            { provide: LoggerToDb, useValue: mockLoggerToDb },
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn().mockImplementation((key: string) => (key == "COOKIE_NAME" ? "shado_cloud_prod" : null)),
               },
            },
         ],
      }).compile();

      authController = module.get<AuthController>(AuthController);
      authService = module.get<AuthService>(AuthService);
      authClient = module.get<AuthClientService>(AuthClientService);
      directoriesService = module.get<DirectoriesService>(DirectoriesService);
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
      const headers = { host: "localhost", origin: "http://localhost" } as IncomingHttpHeaders;

      it("should login successfully and set cookie", async () => {
         const body = { email: "test@example.com", password: "password123" };
         const authResult = { id: "uuid-1", email: body.email, name: "Test" };
         const localUser = { id: 1, email: body.email };

         (authClient.login as jest.Mock).mockResolvedValue(authResult);
         (authService.getByEmail as jest.Mock).mockResolvedValue(localUser);

         await authController.login(headers, body, response);

         expect(authClient.login).toHaveBeenCalledWith(body.email, body.password);
         expect(response.cookie).toHaveBeenCalledWith("shado_cloud_prod", "mocked-jwt-token", expect.any(Object));
      });

      it("should return error on invalid credentials", async () => {
         const body = { email: "bad@example.com", password: "wrong" };
         (authClient.login as jest.Mock).mockResolvedValue({ error: "Invalid credentials" });

         await authController.login(headers, body, response);

         expect(response.send).toHaveBeenCalledWith({
            user: null,
            errors: [{ field: "email", message: "Invalid credentials" }],
         });
      });
   });

   describe("register", () => {
      const headers = { host: "localhost", origin: "http://localhost" } as IncomingHttpHeaders;

      it("should register and set cookie", async () => {
         const body = { name: "New User", email: "new@example.com", password: "password123" };
         const authResult = { id: "uuid-2", email: body.email, name: body.name };
         const localUser = { id: 2, email: body.email };

         (authClient.register as jest.Mock).mockResolvedValue(authResult);
         (authService.new as jest.Mock).mockResolvedValue(localUser);

         await authController.register(headers, body, response);

         expect(authClient.register).toHaveBeenCalledWith(body.email, body.password, body.name);
         expect(authService.new).toHaveBeenCalledWith(body.name, body.email, body.password);
         expect(directoriesService.createNewUserDir).toHaveBeenCalledWith(localUser);
         expect(response.cookie).toHaveBeenCalledWith("shado_cloud_prod", "mocked-jwt-token", expect.any(Object));
      });

      it("should return error if email taken", async () => {
         const body = { name: "User", email: "taken@example.com", password: "pass" };
         (authClient.register as jest.Mock).mockResolvedValue({ error: "Email already registered" });

         await authController.register(headers, body, response);

         expect(response.send).toHaveBeenCalledWith({
            user: null,
            errors: [{ field: "email", message: "Email already registered" }],
         });
      });
   });

   describe("logout", () => {
      it("should clear the cookie", async () => {
         const headers = { host: "localhost" } as IncomingHttpHeaders;
         await authController.logout(headers, response);

         expect(response.clearCookie).toHaveBeenCalledWith("shado_cloud_prod", {
            httpOnly: true,
            domain: "localhost",
         });
         expect(response.send).toHaveBeenCalled();
      });
   });
});
