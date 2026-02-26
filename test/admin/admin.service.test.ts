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
                  entityMetadatas: [
                     { tableName: "log" },
                     { tableName: "user" },
                  ],
                  createQueryBuilder: jest.fn().mockReturnValue({
                     select: jest.fn().mockReturnThis(),
                     from: jest.fn().mockReturnThis(),
                     where: jest.fn().mockReturnThis(),
                     orderBy: jest.fn().mockReturnThis(),
                     limit: jest.fn().mockReturnThis(),
                     delete: jest.fn().mockReturnThis(),
                     update: jest.fn().mockReturnThis(),
                     set: jest.fn().mockReturnThis(),
                     getRawMany: jest.fn().mockResolvedValue([]),
                     getRawOne: jest.fn().mockResolvedValue({ count: "5" }),
                     execute: jest.fn().mockResolvedValue({ affected: 1 }),
                  }),
               },
            },
            {
               provide: getEntityManagerToken(),
               useValue: {
                  query: jest.fn(),
                  getRepository: jest.fn().mockImplementation((table: any) => {
                     const name = typeof table === "string" ? table : table?.name?.toLowerCase() || "unknown";
                     if (name === "user") {
                        return {
                           metadata: {
                              tableName: "user",
                              columns: [
                                 { propertyName: "id" },
                                 { propertyName: "username" },
                                 { propertyName: "password" },
                              ],
                              primaryColumns: [{ propertyName: "id" }],
                           },
                        };
                     }
                     if (name === "encryptedpassword") {
                        return { metadata: { tableName: "encrypted_password" } };
                     }
                     return {
                        metadata: {
                           tableName: name,
                           columns: [{ propertyName: "id" }, { propertyName: "message" }],
                           primaryColumns: [{ propertyName: "id" }],
                        },
                     };
                  }),
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
                  mkdirSync: jest.fn(),
                  readFileSync: jest.fn().mockReturnValue("mock-content"),
                  writeFileSync: jest.fn(),
                  existsSync: jest.fn().mockReturnValue(true),
                  readdirSync: jest.fn().mockReturnValue([]),
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

   describe("getTableCount", () => {
      it("should return count for a valid table", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         const result = await service.getTableCount("log");
         expect(result).toEqual({ count: 5 });
      });

      it("should throw when db access is disabled", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(true);

         await expect(service.getTableCount("log")).rejects.toThrow("Database API access is disabled");
      });
   });

   describe("deleteRow", () => {
      it("should delete a row by primary key", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         const result = await service.deleteRow("log", "1");
         expect(result).toEqual({ success: true });
      });

      it("should throw when db access is disabled", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(true);

         await expect(service.deleteRow("log", "1")).rejects.toThrow("Database API access is disabled");
      });
   });

   describe("updateRow", () => {
      it("should update a row with valid columns", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         const result = await service.updateRow("user", "1", { username: "newname" });
         expect(result).toEqual({ success: true });
      });

      it("should strip password field from user table updates", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         const dataSource = service["dataSource"] as any;
         const qb = dataSource.createQueryBuilder();

         await service.updateRow("user", "1", { username: "test", password: "secret" });

         // set should have been called — password should be stripped
         expect(qb.set).toHaveBeenCalledWith({ username: "test" });
      });

      it("should throw when no valid columns provided", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         await expect(service.updateRow("user", "1", { nonexistent: "value" })).rejects.toThrow();
      });

      it("should throw when db access is disabled", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(true);

         await expect(service.updateRow("user", "1", { username: "test" })).rejects.toThrow("Database API access is disabled");
      });

      it("should reject column names with SQL injection patterns", async () => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);

         await expect(service.updateRow("user", "1", { "username; DROP TABLE user--": "val" })).rejects.toThrow();
         await expect(service.updateRow("user", "1", { "1 OR 1=1": "val" })).rejects.toThrow();
         await expect(service.updateRow("user", "1", { "username' OR '1'='1": "val" })).rejects.toThrow();
      });
   });

   describe("SQL injection prevention", () => {
      beforeEach(() => {
         const featureFlagService = service["featureFlagService"] as any;
         featureFlagService.isFeatureFlagDisabled.mockResolvedValue(false);
      });

      it("should reject search_column with SQL injection", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            search: "test", search_column: "id; DROP TABLE log--",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should reject order_column with SQL injection", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "id; DROP TABLE log--",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should reject column names with spaces", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            search: "x", search_column: "id OR 1=1",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should reject column names with quotes", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "id' AND '1'='1",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should reject column names with parentheses", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "COUNT(id)",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should reject column names starting with numbers", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "1; DROP TABLE log",
         } as any)).rejects.toThrow("Invalid column name");
      });

      it("should allow valid column names with underscores", async () => {
         // "message" is a valid column on the log table mock
         const result = await service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "message",
         } as any);
         expect(result).toBeDefined();
      });

      it("should reject column names not in the whitelist even if format is valid", async () => {
         await expect(service.getTable("log", {
            limit: 10, order_by: "ASC",
            order_column: "nonexistent_column",
         } as any)).rejects.toThrow("does not exist");
      });

      it("should safely handle SQL injection in search values via parameterized queries", async () => {
         const dataSource = service["dataSource"] as any;
         const qb = dataSource.createQueryBuilder();

         await service.getTable("log", {
            limit: 10, order_by: "ASC",
            search: "'; DROP TABLE log; --",
            search_column: "message",
         } as any);

         // The search value should be passed as a parameter, not interpolated
         // Column name should be quoted with backticks
         expect(qb.where).toHaveBeenCalledWith(
            "t.`message` LIKE :search",
            { search: "%'; DROP TABLE log; --%" }
         );
      });

      it("should safely handle SQL injection in delete row id via parameterized queries", async () => {
         const dataSource = service["dataSource"] as any;
         const qb = dataSource.createQueryBuilder();

         await service.deleteRow("log", "1 OR 1=1");

         expect(qb.where).toHaveBeenCalledWith("`id` = :id", { id: "1 OR 1=1" });
      });

      it("should safely handle SQL injection in update row id via parameterized queries", async () => {
         const dataSource = service["dataSource"] as any;
         const qb = dataSource.createQueryBuilder();

         await service.updateRow("log", "1; DROP TABLE log--", { message: "test" });

         expect(qb.where).toHaveBeenCalledWith("`id` = :id", { id: "1; DROP TABLE log--" });
      });
   });
});
