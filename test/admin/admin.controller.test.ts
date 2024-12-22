import { HttpException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AdminController } from "src/admin/admin.controller";
import { AdminService } from "src/admin/admin.service";
import { AdminGuard } from "src/admin/admin.strategy";
import { AppMetricsService } from "src/admin/app-metrics.service";
import { LoggerToDb } from "src/logging";
import { type Log } from "src/models/log";
import { User } from "src/models/user";
import crypto from "crypto";

describe("AdminController", () => {
   let adminController: AdminController;
   let adminService: AdminService;
   let logger: LoggerToDb;
   let configService: ConfigService;

   const mockPayload = { ref: "refs/heads/nest-js-backend" }; // example payload for main branch
   const invalidPayload = { ref: "refs/heads/other-branch" }; // example payload for non-main branch
   const validSignature = "sha256=validsignature"; // Mocked valid signature
   const invalidSignature = "sha256=invalidsignature"; // Mocked invalid signature

   beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
         controllers: [AdminController],
         providers: [
            {
               provide: AdminService,
               useValue: {
                  all: jest.fn(),
                  deleteByIds: jest.fn(async () => {}),
                  redeploy: jest.fn(),
               },
            },
            {
               provide: LoggerToDb,
               useValue: {
                  logException: jest.fn(),
                  log: jest.fn(),
                  warn: jest.fn(),
                  error: jest.fn(),
               },
            },
            {
               provide: AdminGuard,
               useValue: {
                  canActivate: jest.fn().mockReturnValue(true),
               },
            },
            {
               provide: getRepositoryToken(User),
               useValue: {
                  findOne: jest.fn(),
               },
            },
            {
               provide: AppMetricsService,
               useValue: {},
            },
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn().mockReturnValue(""),
               },
            },
         ],
      }).compile();

      adminController = module.get<AdminController>(AdminController);
      adminService = module.get<AdminService>(AdminService);
      logger = module.get<LoggerToDb>(LoggerToDb);
      configService = module.get<ConfigService>(ConfigService);
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe("logs", () => {
      it("should return a list of logs", async () => {
         const mockLogs: Log[] = [{ id: 1, message: "Test log" } as Log];
         jest.spyOn(adminService, "all").mockResolvedValue(mockLogs);

         const result = await adminController.logs();
         expect(result).toEqual(mockLogs);
         expect(adminService.all).toHaveBeenCalledTimes(1);
      });

      it("should return an empty array if an exception occurs", async () => {
         jest.spyOn(adminService, "all").mockRejectedValue(new Error("Test error"));

         const result = await adminController.logs();
         expect(result).toEqual([]);
         expect(logger.logException).toHaveBeenCalled();
      });
   });

   describe("logInfo", () => {
      it("should log a debug message", async () => {
         const logMessage = "This is a debug log to test logging";
         jest.spyOn(logger, "log").mockImplementation();

         await adminController.logInfo();
         expect(logger.log).toHaveBeenCalledWith(logMessage);
      });
   });

   describe("delete", () => {
      it("should delete logs by ids when a single id is passed", async () => {
         const id = "1";
         const mockDeleteResponse = undefined;
         jest.spyOn(adminService, "deleteByIds").mockResolvedValue(mockDeleteResponse);

         await adminController.delete(id);

         expect(adminService.deleteByIds).toHaveBeenCalledWith([1]);
         expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
      });

      it("should delete logs by ids when an array of ids is passed", async () => {
         const id = "[1,2,3]";
         const mockDeleteResponse = undefined;
         jest.spyOn(adminService, "deleteByIds").mockResolvedValue(mockDeleteResponse);

         await adminController.delete(id);

         expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 3]);
         expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
      });

      it("should ignore invalid integers and flatten array in input array", async () => {
         const id = "[1, 2, ni, 4, [5, 6]]";

         await adminController.delete(id);
         expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 4, 5, 6]);
      });

      it("should log an error and throw if invalid ids are provided", async () => {
         const id = "invalid";
         jest.spyOn(logger, "logException").mockImplementation();

         await expect(adminController.delete(id)).rejects.toThrow(HttpException);
         expect(logger.error).toHaveBeenCalled();
         expect(adminService.deleteByIds).not.toHaveBeenCalled();
      });
   });

   describe("redeploy", () => {
      it("should successfully trigger redeployment with valid GitHub signature", async () => {
         // Mocking the signature verification and redeploy process
         const hmacMock = jest.spyOn(crypto, "createHmac").mockReturnValue({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue("validsignature"),
         } as any);

         const redeployMock = jest.spyOn(adminService, "redeploy").mockResolvedValue();
         configService.get = jest.fn().mockReturnValue("githubsecret"); // Return secret

         // Call the redeploy method
         const result = await adminController.redeploy(mockPayload, validSignature);

         // Assertions
         expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
         expect(redeployMock).toHaveBeenCalled();
         expect(result.message).toBe("Deployment triggered successfully");
         expect(logger.log).toHaveBeenCalledWith("Received webhook payload");
         expect(logger.log).toHaveBeenCalledWith("Starting redeployment...");
      });

      it("should throw UnauthorizedException for invalid GitHub signature", async () => {
         const hmacMock = jest.spyOn(crypto, "createHmac").mockReturnValue({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue("invalidsignature"),
         } as any);

         configService.get = jest.fn().mockReturnValue("githubsecret"); // Return secret

         try {
            // Call the redeploy method with an invalid signature
            await adminController.redeploy(mockPayload, invalidSignature);
         } catch (error) {
            // Assertions
            expect(error).toBeInstanceOf(UnauthorizedException);
            expect(logger.warn).toHaveBeenCalledWith("Invalid signature");
            expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
         }
      });

      it("should return error message if redeploy fails", async () => {
         const errorMessage = "Deployment failed";

         // Mocking the signature verification and redeploy process
         const hmacMock = jest.spyOn(crypto, "createHmac").mockReturnValue({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue("validsignature"),
         } as any);

         const redeployMock = jest.spyOn(adminService, "redeploy").mockRejectedValue(new Error(errorMessage));
         configService.get = jest.fn().mockReturnValue("githubsecret"); // Return secret

         // Call the redeploy method
         const result = await adminController.redeploy(mockPayload, validSignature);

         // Assertions
         expect(result.message).toBe(errorMessage);
         expect(logger.error).toHaveBeenCalledWith("Deployment failed " + errorMessage, expect.any(String));
         expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
      });

      it("should return message when not a push to the main branch", async () => {
         const branchName = "nest-js-backend";
         const mockLoggerWarn = jest.spyOn(logger, "warn");

         // Call the redeploy method with a payload that does not match the expected branch
         const result = await adminController.redeploy(invalidPayload, validSignature);

         // Assertions
         expect(result.message).toBe("Not a push to main branch, ignoring");
         expect(mockLoggerWarn).toHaveBeenCalledWith("Ignoring push to non-main branch");
         expect(adminService.redeploy).not.toHaveBeenCalled(); // Ensure redeploy is not called
      });
   });
});
