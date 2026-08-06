import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { type Repository } from "typeorm";
import { type Request } from "express";
import { TempUrlService } from "src/temp-url/tempUrl.service";
import { FilesService } from "src/files/files.service";
import { DirectoriesService } from "src/directories/directories.service";
import { AuthService } from "src/auth/auth.service";
import { TempUrl, TempUrlAccessLevel } from "src/models/tempUrl";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { SoftException } from "src/util";
import { UnauthorizedException } from "@nestjs/common";

// Preserve the real `fs` module and only override existsSync. Replacing the whole
// module breaks graceful-fs (used by jest/ts-jest) which reads fs.realpath.native.
jest.mock("fs", () => ({
   ...jest.requireActual("fs"),
   existsSync: jest.fn().mockReturnValue(true),
}));

// FilesService (imported as a DI token below) pulls in these native/heavy modules at
// import time. Mock them so the test doesn't load native bindings.
jest.mock("sharp", () => jest.fn());
jest.mock("fs-thumbnail");
jest.mock("pdf2pic", () => ({ fromBuffer: jest.fn() }));

/**
 * Regression tests for the temp-URL ownership fix.
 *
 * A temp URL must only ever point at a file the generating user owns. Otherwise a
 * traversal filepath (e.g. "../<victim>/file") would let the publicly reachable
 * PATCH /temp/:url/save endpoint write into another user's storage.
 */
describe("TempUrlService — filepath ownership", () => {
   let service: TempUrlService;
   let fileService: jest.Mocked<Pick<FilesService, "absolutePath" | "isOwner" | "info">>;
   let tempUrlRepo: jest.Mocked<Pick<Repository<TempUrl>, "save" | "findOne">>;
   let fs: jest.Mocked<Pick<AbstractFileSystem, "writeFileSync" | "appendFileSync" | "statSync" | "readdirSync">>;
   let authService: { getById: jest.Mock; validateCookies: jest.Mock };
   let directoriesService: { list: jest.Mock };
   let config: { get: jest.Mock };

   const OWNER_ID = 1;
   const ROOT = "/cloud/owner@example.com";

   const makeRequest = (): Request =>
      ({ protocol: "https", headers: { host: "cloudapi.shadijiha.com" } } as unknown as Request);

   beforeEach(async () => {
      // absolutePath mirrors the real path.join(root, filepath) behaviour so traversal
      // resolves the same way it would in production.
      const path = require("path");
      fileService = {
         absolutePath: jest.fn(async (_userId: number, relativePath: string) => path.join(ROOT, relativePath)),
         isOwner: jest.fn(),
         info: jest.fn().mockResolvedValue({ mime: "text/plain" }),
      } as any;

      tempUrlRepo = {
         save: jest.fn(async (e) => e),
         findOne: jest.fn(),
      } as any;

      // Default: everything is a regular file. Individual tests override for directories.
      fs = {
         writeFileSync: jest.fn(),
         appendFileSync: jest.fn(),
         statSync: jest.fn().mockReturnValue({ isDirectory: () => false, size: 10, mtime: new Date(0) }),
         readdirSync: jest.fn().mockReturnValue([]),
      } as any;

      authService = {
         getById: jest.fn(async (id: number) => ({ id })),
         validateCookies: jest.fn(),
      };

      directoriesService = {
         // Default: an empty directory listing (single page).
         list: jest.fn().mockResolvedValue({
            paginatedItems: [],
            paginationMetadata: { page: 1, limit: 200, total: 0, totalPages: 1, start: 0 },
         }),
      };

      config = { get: jest.fn().mockReturnValue("https://cloud.shadijiha.com") };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            TempUrlService,
            { provide: FilesService, useValue: fileService },
            { provide: AuthService, useValue: authService },
            { provide: DirectoriesService, useValue: directoriesService },
            { provide: getRepositoryToken(TempUrl), useValue: tempUrlRepo },
            { provide: AbstractFileSystem, useValue: fs },
            { provide: ConfigService, useValue: config },
         ],
      }).compile();

      service = module.get<TempUrlService>(TempUrlService);
   });

   describe("generate()", () => {
      it("rejects a traversal filepath that escapes the user's root", async () => {
         fileService.isOwner.mockResolvedValue(false);

         await expect(
            service.generate(makeRequest(), OWNER_ID, "../victim@example.com/secret.txt", 100, new Date(), false),
         ).rejects.toBeInstanceOf(SoftException);

         // Nothing should be persisted for a rejected path.
         expect(tempUrlRepo.save).not.toHaveBeenCalled();
      });

      it("allows a filepath the user owns", async () => {
         fileService.isOwner.mockResolvedValue(true);

         const url = await service.generate(makeRequest(), OWNER_ID, "photos/a.jpg", 100, new Date(), true);

         expect(fileService.isOwner).toHaveBeenCalledWith(OWNER_ID, `${ROOT}/photos/a.jpg`);
         expect(tempUrlRepo.save).toHaveBeenCalledTimes(1);
         expect(url).toMatch(/^https:\/\/cloudapi\.shadijiha\.com\/temp\/.+\/get$/);
      });
   });

   describe("token generation (CSPRNG)", () => {
      const extractToken = (url: string) => url.match(/\/temp\/(.+)\/get$/)?.[1] ?? "";

      it("produces a 64-char alphanumeric token", async () => {
         fileService.isOwner.mockResolvedValue(true);
         const url = await service.generate(makeRequest(), OWNER_ID, "a.txt", 100, new Date(), true);
         const token = extractToken(url);
         expect(token).toHaveLength(64);
         expect(token).toMatch(/^[A-Za-z0-9]{64}$/);
      });

      it("produces unique, non-repeating tokens across many generations", async () => {
         fileService.isOwner.mockResolvedValue(true);
         const tokens = new Set<string>();
         for (let i = 0; i < 200; i++) {
            const url = await service.generate(makeRequest(), OWNER_ID, "a.txt", 100, new Date(), true);
            tokens.add(extractToken(url));
         }
         // No collisions expected from a 32-char CSPRNG token over 200 samples.
         expect(tokens.size).toBe(200);
      });
   });

   describe("save() — defense-in-depth for legacy rows", () => {
      const legacyTraversalUrl = {
         url: "abc",
         filepath: "../victim@example.com/secret.txt",
         is_readonly: false,
         requests: 0,
         max_requests: 100,
         expires_at: new Date(Date.now() + 60_000),
         user: { id: OWNER_ID },
      } as unknown as TempUrl;

      it("refuses to write when the stored filepath resolves outside the owner's root", async () => {
         tempUrlRepo.findOne.mockResolvedValue(legacyTraversalUrl);
         fileService.isOwner.mockResolvedValue(false);

         await expect(service.save("abc", "malicious content")).rejects.toBeInstanceOf(SoftException);

         expect(fs.writeFileSync).not.toHaveBeenCalled();
         expect(fs.appendFileSync).not.toHaveBeenCalled();
      });

      it("writes when the stored filepath is owned by the user", async () => {
         tempUrlRepo.findOne.mockResolvedValue({ ...legacyTraversalUrl, filepath: "notes.txt" } as TempUrl);
         fileService.isOwner.mockResolvedValue(true);

         await service.save("abc", "hello");

         expect(fs.writeFileSync).toHaveBeenCalledWith(`${ROOT}/notes.txt`, "hello");
      });
   });

   describe("generate() — directory shares", () => {
      it("detects a directory and returns the frontend explorer link", async () => {
         fileService.isOwner.mockResolvedValue(true);
         fs.statSync.mockReturnValue({ isDirectory: () => true, size: 0, mtime: new Date(0) } as any);

         // Even if the caller asks for writable, a directory share is forced read-only.
         const url = await service.generate(makeRequest(), OWNER_ID, "docs", 100, new Date(), false);

         const saved = (tempUrlRepo.save as jest.Mock).mock.calls[0][0] as TempUrl;
         expect(saved.is_dir).toBe(true);
         expect(saved.is_readonly).toBe(true);
         // Uses the configured frontend origin, not the API host.
         expect(url).toBe("https://cloud.shadijiha.com/share/" + saved.url);
      });

      it("picks the cloud frontend URL from a comma-separated list", async () => {
         fileService.isOwner.mockResolvedValue(true);
         fs.statSync.mockReturnValue({ isDirectory: () => true, size: 0, mtime: new Date(0) } as any);
         config.get.mockReturnValue("http://localhost:5100, https://cloud.example.com/ , https://music.example.com");

         const url = await service.generate(makeRequest(), OWNER_ID, "docs", 100, new Date(), false);
         const saved = (tempUrlRepo.save as jest.Mock).mock.calls[0][0] as TempUrl;
         // The entry containing "cloud" wins (trailing slash trimmed), not index 0.
         expect(url).toBe("https://cloud.example.com/share/" + saved.url);
      });

      it("persists the access level", async () => {
         fileService.isOwner.mockResolvedValue(true);
         await service.generate(makeRequest(), OWNER_ID, "a.txt", 100, new Date(), true, TempUrlAccessLevel.AUTHENTICATED);
         const saved = (tempUrlRepo.save as jest.Mock).mock.calls[0][0] as TempUrl;
         expect(saved.access_level).toBe(TempUrlAccessLevel.AUTHENTICATED);
         expect(saved.is_dir).toBe(false);
      });

      it("rejects creating a not-yet-supported restricted share", async () => {
         fileService.isOwner.mockResolvedValue(true);
         await expect(
            service.generate(makeRequest(), OWNER_ID, "a.txt", 100, new Date(), true, TempUrlAccessLevel.RESTRICTED),
         ).rejects.toBeInstanceOf(SoftException);
         expect(tempUrlRepo.save).not.toHaveBeenCalled();
      });
   });

   describe("authenticated access gate", () => {
      const authedDirShare = {
         url: "tok",
         filepath: "docs",
         is_readonly: true,
         is_dir: true,
         access_level: TempUrlAccessLevel.AUTHENTICATED,
         requests: 0,
         max_requests: 100,
         expires_at: new Date(Date.now() + 60_000),
         user: { id: OWNER_ID },
      } as unknown as TempUrl;

      it("rejects listing when no session cookie is present", async () => {
         tempUrlRepo.findOne.mockResolvedValue(authedDirShare);
         await expect(service.listDir("tok", "", undefined)).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it("rejects listing when the cookie is invalid", async () => {
         tempUrlRepo.findOne.mockResolvedValue(authedDirShare);
         authService.validateCookies.mockResolvedValue(null);
         await expect(service.listDir("tok", "", "session=bad")).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it("allows listing for any authenticated user", async () => {
         tempUrlRepo.findOne.mockResolvedValue(authedDirShare);
         fileService.isOwner.mockResolvedValue(true);
         authService.validateCookies.mockResolvedValue("some-shado-user-id");
         fs.statSync.mockReturnValue({ isDirectory: () => true, size: 0, mtime: new Date(0) } as any);
         fs.readdirSync.mockReturnValue([]);

         const res = await service.listDir("tok", "", "session=good");
         expect(res.entries).toEqual([]);
         expect(res.errors).toEqual([]);
      });
   });

   describe("listDir() — traversal safety", () => {
      const dirShare = {
         url: "tok",
         filepath: "docs",
         is_readonly: true,
         is_dir: true,
         access_level: TempUrlAccessLevel.PUBLIC,
         requests: 0,
         max_requests: 100,
         expires_at: new Date(Date.now() + 60_000),
         user: { id: OWNER_ID },
      } as unknown as TempUrl;

      it("rejects a sub-path that escapes the shared directory", async () => {
         tempUrlRepo.findOne.mockResolvedValue(dirShare);
         await expect(service.listDir("tok", "../../etc", undefined)).rejects.toBeInstanceOf(SoftException);
      });

      it("lists entries within the shared directory", async () => {
         tempUrlRepo.findOne.mockResolvedValue(dirShare);
         fileService.isOwner.mockResolvedValue(true);
         fs.statSync.mockReturnValue({ isDirectory: () => true, size: 0, mtime: new Date(0) } as any);

         // Enumeration is delegated to DirectoriesService.list (paths are user-root relative:
         // a dir entry's `path` is the listing dir, a file entry's `path` is the full path).
         directoriesService.list.mockResolvedValue({
            paginatedItems: [
               { name: "sub", path: "docs", is_dir: true, lastModified: "2026-01-01T00:00:00.000Z" },
               {
                  name: "report.pdf",
                  path: "docs/report.pdf",
                  is_dir: false,
                  size: 1234,
                  mime: "application/pdf",
                  lastModified: "2026-01-01T00:00:00.000Z",
                  extension: ".pdf",
                  is_image: false,
                  is_video: false,
                  is_audio: false,
                  is_pdf: true,
                  is_text: false,
               },
               { name: ".hidden", path: "docs/.hidden", is_dir: false, is_pdf: false },
            ],
            paginationMetadata: { page: 1, limit: 200, total: 3, totalPages: 1, start: 0 },
         });

         const res = await service.listDir("tok", "", undefined);
         // Dot entries are hidden; paths are remapped relative to the share root.
         expect(res.entries.map((e) => e.name)).toEqual(["sub", "report.pdf"]);
         expect(res.entries.find((e) => e.name === "sub")!.path).toBe("sub");

         const file = res.entries.find((e) => e.name === "report.pdf")!;
         expect(file.path).toBe("report.pdf");
         expect(file.is_pdf).toBe(true);
         expect(file.mime).toBe("application/pdf");
         expect(file.size).toBe(1234);
         // Listing is delegated rather than re-implemented.
         expect(directoriesService.list).toHaveBeenCalled();
      });
   });

   describe("asStream() — single-file share ignores sub-paths", () => {
      const fileShare = {
         url: "tok",
         filepath: "notes.txt",
         is_readonly: true,
         is_dir: false,
         access_level: TempUrlAccessLevel.PUBLIC,
         requests: 0,
         max_requests: 100,
         expires_at: new Date(Date.now() + 60_000),
         user: { id: OWNER_ID },
      } as unknown as TempUrl;

      it("rejects a sub-path on a single-file share", async () => {
         tempUrlRepo.findOne.mockResolvedValue(fileShare);
         await expect(service.asStream("tok", "anything", undefined)).rejects.toBeInstanceOf(SoftException);
      });
   });

   describe("save() — directory shares are read-only", () => {
      it("rejects any write to a directory share", async () => {
         tempUrlRepo.findOne.mockResolvedValue({
            url: "tok",
            filepath: "docs",
            is_readonly: false, // even a legacy writable row must be refused
            is_dir: true,
            access_level: TempUrlAccessLevel.PUBLIC,
            requests: 0,
            max_requests: 100,
            expires_at: new Date(Date.now() + 60_000),
            user: { id: OWNER_ID },
         } as unknown as TempUrl);

         await expect(service.save("tok", "data", false, "child.txt")).rejects.toBeInstanceOf(SoftException);
         expect(fs.writeFileSync).not.toHaveBeenCalled();
         expect(fs.appendFileSync).not.toHaveBeenCalled();
      });
   });
});
