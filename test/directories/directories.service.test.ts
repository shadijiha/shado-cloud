import { DirectoriesService } from "src/directories/directories.service";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { AppLogger } from "src/logging";
import { ConfigService } from "@nestjs/config";
import { TieredStorageService } from "src/file-system/tiered-storage.service";
import { AbstractFileSystem, Dirent, State } from "src/file-system/abstract-file-system.interface";
import { UploadedFile } from "src/models/uploadedFile";
import { SearchStat } from "src/models/stats/searchStat";
import { Repository } from "typeorm";
import { EnvVariables } from "src/config/config.validator";

describe("DirectoriesService.list", () => {
   let service: DirectoriesService;
   let fileService: jest.Mocked<Pick<FilesService, "absolutePath" | "isOwner" | "getUserRootPath" | "info">>;
   let fs: jest.Mocked<Pick<AbstractFileSystem, "readdirSync" | "statSync">>;
   let logger: jest.Mocked<Pick<AppLogger, "error">>;

   beforeEach(() => {
      fileService = {
         absolutePath: jest.fn().mockResolvedValue("/root/folder"),
         isOwner: jest.fn().mockResolvedValue(true),
         getUserRootPath: jest.fn().mockResolvedValue("/root"),
         info: jest.fn().mockImplementation(async (_userId: number, relPath: string) => ({
            name: relPath.split("/").pop(),
            path: relPath,
            is_dir: false,
            lastModified: "2024-01-01T00:00:00.000Z",
         })),
      } as unknown as jest.Mocked<Pick<FilesService, "absolutePath" | "isOwner" | "getUserRootPath" | "info">>;

      fs = {
         readdirSync: jest.fn(),
         statSync: jest.fn(),
      } as unknown as jest.Mocked<Pick<AbstractFileSystem, "readdirSync" | "statSync">>;

      logger = {
         error: jest.fn(),
      } as unknown as jest.Mocked<Pick<AppLogger, "error">>;

      service = new DirectoriesService(
         {} as AuthService,
         fileService as unknown as FilesService,
         {} as Repository<UploadedFile>,
         {} as Repository<SearchStat>,
         logger as unknown as AppLogger,
         fs as unknown as AbstractFileSystem,
         { get: jest.fn() } as unknown as ConfigService<EnvVariables, false>,
         { removeColdData: jest.fn().mockResolvedValue(undefined) } as unknown as TieredStorageService,
      );
   });

   it("sorts entries before pagination so the second page stays in the same sorted order", async () => {
      fs.readdirSync.mockReturnValue([
         { name: "zeta.txt", isDirectory: () => false },
         { name: "alpha.txt", isDirectory: () => false },
         { name: "beta", isDirectory: () => true },
         { name: "delta.txt", isDirectory: () => false },
      ] as Dirent[]);

      fs.statSync.mockImplementation((filePath: string) => ({
         mtime: new Date(filePath.endsWith("beta") ? "2024-01-01T00:00:00.000Z" : "2024-01-02T00:00:00.000Z"),
      } as State));

      const result = await service.list(1, "", false, false, { page: 2, limit: 2 }, [["name", "ASC"]]);

      expect(result.paginatedItems.map((item) => item.name)).toEqual(["delta.txt", "zeta.txt"]);
      expect(result.paginationMetadata?.total).toBe(4);
   });

   it("sorts by last modified time when requested, while keeping directories first", async () => {
      fs.readdirSync.mockReturnValue([
         { name: "older.txt", isDirectory: () => false },
         { name: "folder", isDirectory: () => true },
         { name: "newer.txt", isDirectory: () => false },
      ] as Dirent[]);

      fs.statSync.mockImplementation((filePath: string) => ({
         mtime: new Date(filePath.includes("newer") ? "2024-01-03T00:00:00.000Z" : filePath.includes("older") ? "2024-01-01T00:00:00.000Z" : "2024-01-02T00:00:00.000Z"),
      } as State));

      const result = await service.list(1, "", false, false, undefined, [["lastModified", "DESC"]]);

      expect(result.paginatedItems.map((item) => item.name)).toEqual(["folder", "newer.txt", "older.txt"]);
   });
});
