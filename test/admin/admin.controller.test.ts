import { HttpException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AdminController } from "src/admin/admin.controller";
import { AdminService } from "src/admin/admin.service";
import { AdminGuard } from "src/admin/admin.strategy";
import { AppLogger } from "src/logging";
import { User } from "src/models/user";
import crypto from "crypto";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { DeploymentService } from "src/admin/deployment.service";
import { AuthService } from "src/auth/auth.service";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { TieredStorageService } from "src/file-system/tiered-storage.service";
import { CronAdminService } from "src/admin/cron.service";

describe("AdminController", () => {
   let adminController: AdminController;
   let adminService: AdminService;
   let logger: AppLogger;
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
                  deleteByIds: jest.fn(async () => { }),
                  redeploy: jest.fn(),
                  getTableCount: jest.fn().mockResolvedValue({ count: 10 }),
                  deleteRow: jest.fn().mockResolvedValue({ success: true }),
                  updateRow: jest.fn().mockResolvedValue({ success: true }),
               },
            },
            {
               provide: AppLogger,
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
               provide: JwtAuthGuard,
               useValue: {
                  canActivate: jest.fn().mockReturnValue(true),
               },
            },
            {
               provide: AuthService,
               useValue: {
                  validateToken: jest.fn().mockResolvedValue(1),
                  getById: jest.fn(),
                  isAdmin: jest.fn().mockResolvedValue(true),
               },
            },
            {
               provide: getRepositoryToken(User),
               useValue: {
                  findOne: jest.fn(),
               },
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
                  getProject: jest.fn().mockResolvedValue({ slug: "backend", branch: "master", enabled: true }),
               },
            },
            {
               provide: TieredStorageService,
               useValue: {
                  getOverview: jest.fn().mockResolvedValue({ flags: { demotion: false, promotion: false }, redis: { usedMemory: 0, maxMemory: 0 }, drives: [] }),
               },
            },
            {
               provide: CronAdminService,
               useValue: {
                  list: jest.fn().mockReturnValue([]),
                  trigger: jest.fn().mockResolvedValue({ name: "x", triggeredAt: new Date().toISOString() }),
               },
            },
            {
               provide: AbstractFileSystem,
               useValue: {
                  unlinkSync: jest.fn(),
                  mkdirSync: jest.fn(),
                  readFileSync: jest.fn().mockReturnValue("mock-content"),
                  writeFileSync: jest.fn(),
                  existsSync: jest.fn().mockReturnValue(true),
                  readdirSync: jest.fn().mockReturnValue([]),
               }
            }
         ],
      }).compile();

      adminController = module.get<AdminController>(AdminController);
      adminService = module.get<AdminService>(AdminService);
      logger = module.get<AppLogger>(AppLogger);
      configService = module.get<ConfigService>(ConfigService);
   });

   afterEach(() => {
      jest.clearAllMocks();
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
