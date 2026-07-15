import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { type Repository } from "typeorm";
import { type Request } from "express";
import { TempUrlService } from "src/temp-url/tempUrl.service";
import { FilesService } from "src/files/files.service";
import { AuthService } from "src/auth/auth.service";
import { TempUrl } from "src/models/tempUrl";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { SoftException } from "src/util";

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
   let fs: jest.Mocked<Pick<AbstractFileSystem, "writeFileSync" | "appendFileSync">>;

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

      fs = {
         writeFileSync: jest.fn(),
         appendFileSync: jest.fn(),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            TempUrlService,
            { provide: FilesService, useValue: fileService },
            { provide: AuthService, useValue: { getById: jest.fn(async (id: number) => ({ id })) } },
            { provide: getRepositoryToken(TempUrl), useValue: tempUrlRepo },
            { provide: AbstractFileSystem, useValue: fs },
            { provide: ConfigService, useValue: { get: jest.fn() } },
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

      it("produces a 32-char alphanumeric token", async () => {
         fileService.isOwner.mockResolvedValue(true);
         const url = await service.generate(makeRequest(), OWNER_ID, "a.txt", 100, new Date(), true);
         const token = extractToken(url);
         expect(token).toHaveLength(32);
         expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
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
});
