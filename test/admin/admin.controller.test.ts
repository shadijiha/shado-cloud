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
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { DeploymentService } from "src/admin/deployment.service";

describe("AdminController", () => {
   let adminController: AdminController;
   let adminService: AdminService;
   let logger: LoggerToDb;
   let configService: ConfigService;

   const mockPayload = { ref: "refs/heads/master" }; // example payload for main branch
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
                  getTableCount: jest.fn().mockResolvedValue({ count: 10 }),
                  deleteRow: jest.fn().mockResolvedValue({ success: true }),
                  updateRow: jest.fn().mockResolvedValue({ success: true }),
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
            {
               provide: FeatureFlagService,
               useValue: {},
            },
            {
               provide: DeploymentService,
               useValue: {
                  isRunning: jest.fn().mockReturnValue(false),
                  getCurrentDeployment: jest.fn().mockReturnValue(null),
                  startDeployment: jest.fn(),
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
         const ids = ["1"];
         const mockDeleteResponse = undefined;
         jest.spyOn(adminService, "deleteByIds").mockResolvedValue(mockDeleteResponse);

         adminController.delete({ ids });

         expect(adminService.deleteByIds).toHaveBeenCalledWith([1]);
         expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
      });

      it("should delete logs by ids when an array of ids is passed", async () => {
         const ids = ["1", "2", "3"];
         const mockDeleteResponse = undefined;
         jest.spyOn(adminService, "deleteByIds").mockResolvedValue(mockDeleteResponse);

         adminController.delete({ ids });

         expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 3]);
         expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
      });

      it("should ignore invalid integers in input array", async () => {
         const ids = ["1", "2", "ni", "4", "[5, 6]"];

         adminController.delete({ ids });
         expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 4]);
      });

      it("should throw if array of invalid ids is provided", async () => {
         const ids = ["invalid"];
         jest.spyOn(logger, "logException").mockImplementation();

         expect(() => adminController.delete({ ids })).toThrow(HttpException);
         expect(adminService.deleteByIds).not.toHaveBeenCalled();
      });

      it("should throw if ids not being a valid array object", async () => {
         const ids = "invalid";
         jest.spyOn(logger, "logException").mockImplementation();

         expect(() => adminController.delete({ ids: ids as unknown as string[] })).toThrow(HttpException);
         expect(adminService.deleteByIds).not.toHaveBeenCalled();
      });
   });

   describe("redeploy", () => {
      let deploymentService: any;

      beforeEach(() => {
         deploymentService = adminController["deploymentService"];
      });

      it("should successfully trigger redeployment with valid GitHub signature", async () => {
         // Mocking the signature verification and redeploy process
         const hmacMock = jest.spyOn(crypto, "createHmac").mockReturnValue({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue("validsignature"),
         } as any);

         const startDeploymentMock = jest.spyOn(deploymentService, "startDeployment").mockReturnValue({});
         configService.get = jest.fn().mockReturnValue("githubsecret"); // Return secret

         // Call the redeploy method
         const result = await adminController.redeploy("backend", mockPayload, validSignature);

         // Assertions
         expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
         expect(startDeploymentMock).toHaveBeenCalledWith("backend", "github-webhook");
         expect(result.message).toBe("Deployment triggered successfully");
         expect(logger.log).toHaveBeenCalledWith("Received backend webhook payload");
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
            await adminController.redeploy("backend", mockPayload, invalidSignature);
         } catch (error) {
            // Assertions
            expect(error).toBeInstanceOf(UnauthorizedException);
            expect(logger.warn).toHaveBeenCalledWith("Invalid signature");
            expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
         }
      });

      it("should return error message if deployment fails to start", async () => {
         const errorMessage = "Deployment failed";

         // Mocking the signature verification and redeploy process
         const hmacMock = jest.spyOn(crypto, "createHmac").mockReturnValue({
            update: jest.fn().mockReturnThis(),
            digest: jest.fn().mockReturnValue("validsignature"),
         } as any);

         jest.spyOn(deploymentService, "startDeployment").mockImplementation(() => {
            throw new Error(errorMessage);
         });
         configService.get = jest.fn().mockReturnValue("githubsecret"); // Return secret

         // Call the redeploy method
         const result = await adminController.redeploy("backend", mockPayload, validSignature);

         // Assertions
         expect(result.message).toBe(errorMessage);
         expect(logger.error).toHaveBeenCalledWith("Deployment failed " + errorMessage, expect.any(String));
         expect(hmacMock).toHaveBeenCalledWith("sha256", "githubsecret");
      });

      it("should return message when not a push to the main branch", async () => {
         const branchName = "master";
         const mockLoggerWarn = jest.spyOn(logger, "warn");

         // Call the redeploy method with a payload that does not match the expected branch
         const result = await adminController.redeploy("backend", invalidPayload, validSignature);

         // Assertions
         expect(result.message).toBe(`Not a push to ${branchName} branch, ignoring`);
         expect(mockLoggerWarn).toHaveBeenCalledWith(`Ignoring push to non-${branchName} branch`);
      });
   });

   describe("database endpoints", () => {
      it("getTableCount should call service", async () => {
         const result = await adminController.getTableCount("user");
         expect(result).toEqual({ count: 10 });
         expect(adminService.getTableCount).toHaveBeenCalledWith("user");
      });

      it("deleteRow should call service with table and id", async () => {
         const result = await adminController.deleteRow("user", "5");
         expect(result).toEqual({ success: true });
         expect(adminService.deleteRow).toHaveBeenCalledWith("user", "5");
      });

      it("updateRow should call service with table, id, and body", async () => {
         const body = { username: "newname" };
         const result = await adminController.updateRow("user", "5", body);
         expect(result).toEqual({ success: true });
         expect(adminService.updateRow).toHaveBeenCalledWith("user", "5", body);
      });
   });

   describe("getServerSetup", () => {
      it("should call service with sudo password", async () => {
         const mockBuffer = Buffer.from("zip-content");
         adminService.generateServerSetupBackup = jest.fn().mockResolvedValue(mockBuffer);

         const mockRes = { set: jest.fn() };

         await adminController.getServerSetup({ sudoPassword: "secret123" }, mockRes as any);

         expect(adminService.generateServerSetupBackup).toHaveBeenCalledWith("secret123");
      });

      it("should call service without password when not provided", async () => {
         const mockBuffer = Buffer.from("zip-content");
         adminService.generateServerSetupBackup = jest.fn().mockResolvedValue(mockBuffer);

         const mockRes = { set: jest.fn() };

         await adminController.getServerSetup({}, mockRes as any);

         expect(adminService.generateServerSetupBackup).toHaveBeenCalledWith(undefined);
      });

      it("should set correct response headers", async () => {
         const mockBuffer = Buffer.from("zip-content");
         adminService.generateServerSetupBackup = jest.fn().mockResolvedValue(mockBuffer);

         const mockRes = { set: jest.fn() };

         await adminController.getServerSetup({}, mockRes as any);

         expect(mockRes.set).toHaveBeenCalledWith({
            "Content-Type": "application/zip",
            "Content-Disposition": expect.stringContaining("server-setup-"),
         });
      });
   });

   describe("downloadBackup", () => {
      it("should pipe stream and delete file on close", async () => {
         const mockStream = {
            pipe: jest.fn(),
            on: jest.fn((event, cb) => {
               if (event === "close") cb();
            }),
         };
         adminService.getBackupFile = jest.fn().mockResolvedValue(mockStream);
         adminService.deleteBackupFile = jest.fn();

         const mockRes = { set: jest.fn() };

         await adminController.downloadBackup("/tmp/server-backup-123.zip", mockRes as any);

         expect(mockStream.pipe).toHaveBeenCalledWith(mockRes);
         expect(adminService.deleteBackupFile).toHaveBeenCalledWith("/tmp/server-backup-123.zip");
      });

      it("should set correct headers for download", async () => {
         const mockStream = { pipe: jest.fn(), on: jest.fn() };
         adminService.getBackupFile = jest.fn().mockResolvedValue(mockStream);

         const mockRes = { set: jest.fn() };

         await adminController.downloadBackup("/tmp/cloud-backup-456.zip", mockRes as any);

         expect(mockRes.set).toHaveBeenCalledWith({
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="cloud-backup-456.zip"`,
         });
      });
   });

   describe("background images", () => {
      it("getBackgrounds should call service", async () => {
         adminService.getBackgroundImages = jest.fn().mockResolvedValue({ images: ["bg1.jpg"] });

         const result = await adminController.getBackgrounds();

         expect(adminService.getBackgroundImages).toHaveBeenCalled();
         expect(result).toEqual({ images: ["bg1.jpg"] });
      });

      it("uploadBackground should call service with file", async () => {
         const mockFile = { originalname: "test.jpg" } as Express.Multer.File;
         adminService.uploadBackgroundImage = jest.fn().mockResolvedValue({ filename: "bg_123.jpg" });

         const result = await adminController.uploadBackground(mockFile);

         expect(adminService.uploadBackgroundImage).toHaveBeenCalledWith(mockFile);
         expect(result).toEqual({ filename: "bg_123.jpg" });
      });

      it("deleteBackground should call service with filename", async () => {
         adminService.deleteBackgroundImage = jest.fn().mockResolvedValue(undefined);

         await adminController.deleteBackground("bg_123.jpg");

         expect(adminService.deleteBackgroundImage).toHaveBeenCalledWith("bg_123.jpg");
      });

      it("getBackgroundImage should set headers and call service", async () => {
         const mockStream = { pipe: jest.fn() };
         adminService.getBackgroundImageStream = jest.fn().mockResolvedValue(mockStream);

         const mockRes = { set: jest.fn() };
         await adminController.getBackgroundImage("bg_123.jpg", mockRes as any);

         expect(adminService.getBackgroundImageStream).toHaveBeenCalledWith("bg_123.jpg");
         expect(mockRes.set).toHaveBeenCalledWith({ "Content-Type": "image/jpeg" });
      });
   });
});
