import { Test, type TestingModule } from "@nestjs/testing";
import { AdminService } from "src/admin/admin.service";
import { getDataSourceToken, getEntityManagerToken, getRepositoryToken } from "@nestjs/typeorm";
import { Log } from "src/models/log";
import { type Repository } from "typeorm";
import { LoggerToDb } from "src/logging";
import { ConfigService } from "@nestjs/config";
import { exec } from "child_process";
import nodemailer from "nodemailer";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { EmailService } from "../../src/admin/email.service";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";

jest.mock("child_process", () => ({
   exec: jest.fn(),
}));
jest.mock("nodemailer");

describe("AdminService", () => {
   let service: AdminService;
   let logRepo: Repository<Log>;
   let logger: LoggerToDb;
   let abstractFs: AbstractFileSystem;

   const sendMailMock = jest.fn();

   beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AdminService,
            {
               provide: getRepositoryToken(Log),
               useValue: {
                  find: jest.fn(),
                  delete: jest.fn(),
               },
            },
            {
               provide: LoggerToDb,
               useValue: {
                  log: jest.fn(),
                  error: jest.fn(),
                  warn: jest.fn(),
               },
            },
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn().mockImplementation((key: string) => {
                     if (key === "EMAIL_USER") return "test@example.com";
                     if (key === "EMAIL_APP_PASSWORD") return "app-password";
                     return undefined;
                  }),
               },
            },
            {
               provide: FeatureFlagService,
               useValue: {
                  isFeatureFlagDisabled: jest.fn(),
               },
            },
            {
               provide: getDataSourceToken(),
               useValue: {
                  query: jest.fn(),
               },
            },
            {
               provide: getEntityManagerToken(),
               useValue: {
                  query: jest.fn(),
               },
            },
            {
               provide: EmailService,
               useValue: {
                  sendEmail: sendMailMock
               }
            },
            {
               provide: AbstractFileSystem,
               useValue: {
                  unlinkSync: jest.fn(),
               }
            }
         ],
      }).compile();

      service = module.get<AdminService>(AdminService);
      logRepo = module.get<Repository<Log>>(getRepositoryToken(Log));
      logger = module.get<LoggerToDb>(LoggerToDb);
      abstractFs = module.get<AbstractFileSystem>(AbstractFileSystem);

      nodemailer.createTransport.mockReturnValue({ sendMail: sendMailMock });
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe("all", () => {
      it("should return logs sorted by created_at in descending order", async () => {
         // Arrange: Mock data
         const logs = [
            { created_at: new Date("2023-01-01"), user: { id: 1 } } as Log,
            { created_at: new Date("2024-01-01"), user: { id: 2 } } as Log,
         ];
         jest.spyOn(logRepo, "find").mockResolvedValue(logs);

         // Act: Call the method
         const result = await service.all();

         // Assert: Check that the result is sorted in descending order
         expect(result).toEqual([
            { created_at: new Date("2024-01-01"), user: { id: 2 } } as Log,
            { created_at: new Date("2023-01-01"), user: { id: 1 } } as Log,
         ]);
      });
   });

   describe("deleteByIds", () => {
      it("should delete logs by their IDs", async () => {
         // Arrange: Prepare input
         const idsToDelete = [1, 2, 3];
         const deleteSpy = jest.spyOn(logRepo, "delete").mockResolvedValue({ affected: 3, raw: [] });

         // Act: Call the delete method
         await service.deleteByIds(idsToDelete);

         // Assert: Verify that delete was called with the correct argument
         expect(deleteSpy).toHaveBeenCalledWith(idsToDelete);
      });
   });

   describe("generateServerSetupBackup", () => {
      it("should call execSync for mysql dump", async () => {
         const execSyncMock = jest.fn().mockResolvedValue({ stdout: "" });
         // @ts-expect-error
         service.execSync = execSyncMock;
         // @ts-expect-error
         service.createZipBuffer = jest.fn().mockResolvedValue(Buffer.from("zip"));

         try {
            await service.generateServerSetupBackup();
         } catch {
            // May fail due to fs operations, but we're testing execSync was called
         }

         expect(execSyncMock).toHaveBeenCalledWith(expect.stringContaining("mysqldump"));
      });

      it("should include sudo prefix when password provided on linux", async () => {
         const execSyncMock = jest.fn().mockResolvedValue({ stdout: "" });
         // @ts-expect-error
         service.execSync = execSyncMock;
         // @ts-expect-error
         service.createZipBuffer = jest.fn().mockResolvedValue(Buffer.from("zip"));

         const originalPlatform = process.platform;
         Object.defineProperty(process, "platform", { value: "linux" });

         try {
            await service.generateServerSetupBackup("testpass");
         } catch {
            // May fail due to fs operations
         }

         expect(execSyncMock).toHaveBeenCalledWith(expect.stringContaining("echo 'testpass' | sudo -S"));

         Object.defineProperty(process, "platform", { value: originalPlatform });
      });
   });

   describe("deleteBackupFile", () => {
      it("should call abstractFs.unlinkSync with file path", () => {
         service.deleteBackupFile("/tmp/server-backup-123.zip");

         expect(abstractFs.unlinkSync).toHaveBeenCalledWith("/tmp/server-backup-123.zip");
      });

      it("should log error when unlinkSync fails", () => {
         (abstractFs.unlinkSync as jest.Mock).mockImplementation(() => {
            throw new Error("File not found");
         });

         service.deleteBackupFile("/tmp/server-backup-123.zip");

         expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to delete backup file")
         );
      });
   });

   describe("uploadBackgroundImage", () => {
      it("should throw when no file provided", async () => {
         await expect(service.uploadBackgroundImage(null as any)).rejects.toThrow("No file provided");
      });

      it("should throw for invalid file type", async () => {
         const file = { mimetype: "text/plain", originalname: "test.txt", buffer: Buffer.from("") } as Express.Multer.File;
         await expect(service.uploadBackgroundImage(file)).rejects.toThrow("Invalid file type");
      });
   });

   describe("deleteBackgroundImage", () => {
      it("should throw for path traversal attempt", async () => {
         await expect(service.deleteBackgroundImage("../etc/passwd")).rejects.toThrow("Invalid filename");
         await expect(service.deleteBackgroundImage("foo/bar.jpg")).rejects.toThrow("Invalid filename");
      });
   });

   describe("getBackgroundImageStream", () => {
      it("should throw for path traversal attempt", async () => {
         await expect(service.getBackgroundImageStream("../etc/passwd")).rejects.toThrow("Invalid filename");
      });
   });
});
