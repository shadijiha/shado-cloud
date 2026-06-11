import { DynamicFileSystemService } from "src/file-system/dynamic-file-system.service";
import { NodeFileSystemService } from "src/file-system/file-system.service";
import { DynamicFileEntity } from "src/models/dynamicFile";
import * as fs from "fs";

/**
 * These tests exercise the cold-storage tiering logic of DynamicFileSystemService.
 *
 * The service extends NodeFileSystemService and delegates the actual disk work to
 * `super.*`. We spy on NodeFileSystemService.prototype so every `super.exists/rename/...`
 * call is intercepted, letting us assert the tiering behaviour without touching disk.
 *
 * onModuleInit() (which probes /sys/block for physical drives) is intentionally NOT
 * called — it is irrelevant to the path-resolution logic under test.
 */
describe("DynamicFileSystemService - cold storage", () => {
   let service: DynamicFileSystemService;
   let repo: {
      findOne: jest.Mock;
      remove: jest.Mock;
      createQueryBuilder: jest.Mock;
      count: jest.Mock;
      save: jest.Mock;
      find: jest.Mock;
   };
   let config: { get: jest.Mock };
   let featureFlag: { isFeatureFlagEnabled: jest.Mock };

   // Helper: build the query-builder mock used by readdir/rmdir
   const queryBuilderReturning = (rows: DynamicFileEntity[]) => ({
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
   });

   const dyn = (over: Partial<DynamicFileEntity> = {}): DynamicFileEntity =>
      ({ id: "uuid-1", path: "/cloud/file.txt", driveName: "hdd1", ...over } as DynamicFileEntity);

   // Cold path layout produced by getColdStoragePath: /mnt/<driveName>/cloud-dir/<id>
   const coldPathOf = (f: DynamicFileEntity) => `/mnt/${f.driveName}/cloud-dir/${f.id}`;

   // Prototype spies for the underlying (super) NodeFileSystemService
   let superExists: jest.SpyInstance;
   let superRename: jest.SpyInstance;
   let superUnlink: jest.SpyInstance;
   let superRmdir: jest.SpyInstance;
   let superReaddir: jest.SpyInstance;
   let superReadFile: jest.SpyInstance;
   let superStat: jest.SpyInstance;
   let superCreateReadStream: jest.SpyInstance;
   let superMkdir: jest.SpyInstance;

   beforeEach(() => {
      repo = {
         findOne: jest.fn().mockResolvedValue(null),
         remove: jest.fn().mockResolvedValue(undefined),
         createQueryBuilder: jest.fn().mockReturnValue(queryBuilderReturning([])),
         count: jest.fn().mockResolvedValue(0),
         save: jest.fn().mockResolvedValue(undefined),
         find: jest.fn().mockResolvedValue([]),
      };
      config = {
         get: jest.fn().mockImplementation((key: string) => {
            if (key === "this-service.cloud-dir") return "/cloud";
            if (key === "this-service.cold-storage") return { drives: ["coldhdd"] };
            return undefined;
         }),
      };
      featureFlag = { isFeatureFlagEnabled: jest.fn().mockResolvedValue(true) };

      service = new DynamicFileSystemService(repo as any, config as any, featureFlag as any);

      superExists = jest.spyOn(NodeFileSystemService.prototype, "exists").mockResolvedValue(false);
      superRename = jest.spyOn(NodeFileSystemService.prototype, "rename").mockResolvedValue(undefined);
      superUnlink = jest.spyOn(NodeFileSystemService.prototype, "unlink").mockResolvedValue(undefined);
      superRmdir = jest.spyOn(NodeFileSystemService.prototype, "rmdir").mockResolvedValue(undefined);
      superReaddir = jest.spyOn(NodeFileSystemService.prototype, "readdir").mockResolvedValue([]);
      superReadFile = jest.spyOn(NodeFileSystemService.prototype, "readFile").mockResolvedValue("data");
      superStat = jest.spyOn(NodeFileSystemService.prototype, "stat").mockResolvedValue({ size: 10 } as any);
      superCreateReadStream = jest
         .spyOn(NodeFileSystemService.prototype, "createReadStream")
         .mockResolvedValue({ pipe: jest.fn() } as any);
      superMkdir = jest.spyOn(NodeFileSystemService.prototype, "mkdir").mockResolvedValue(undefined as any);
   });

   afterEach(() => jest.restoreAllMocks());

   describe("exists", () => {
      it("returns true immediately when the file is on the main drive", async () => {
         superExists.mockResolvedValue(true);

         expect(await service.exists("/cloud/file.txt")).toBe(true);
         expect(repo.findOne).not.toHaveBeenCalled();
      });

      it("returns false when not on main drive and no cold-storage record exists", async () => {
         superExists.mockResolvedValue(false);
         repo.findOne.mockResolvedValue(null);

         expect(await service.exists("/cloud/file.txt")).toBe(false);
      });

      it("returns true when the file lives on a cold drive", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         expect(await service.exists(file.path)).toBe(true);
         expect(superExists).toHaveBeenCalledWith(coldPathOf(file));
      });
   });

   describe("readFile", () => {
      it("reads directly from the main drive without promoting when the file is hot", async () => {
         superExists.mockResolvedValue(true); // on main drive

         const result = await service.readFile("/cloud/file.txt", "utf-8");

         expect(result).toBe("data");
         expect(superRename).not.toHaveBeenCalled();
         expect(superReadFile).toHaveBeenCalledWith("/cloud/file.txt", "utf-8");
      });

      it("promotes a cold file back to the main drive before reading", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         // not on main, but present at the cold path
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await service.readFile(file.path, "utf-8");

         // moved cold -> original path, index entry removed, then read from original path
         expect(superRename).toHaveBeenCalledWith(coldPathOf(file), file.path);
         expect(repo.remove).toHaveBeenCalledWith(file);
         expect(superReadFile).toHaveBeenCalledWith(file.path, "utf-8");
      });
   });

   describe("createReadStream", () => {
      it("promotes a cold file before streaming it", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await service.createReadStream(file.path);

         expect(superRename).toHaveBeenCalledWith(coldPathOf(file), file.path);
         expect(superCreateReadStream).toHaveBeenCalledWith(file.path, undefined);
      });
   });

   describe("rename", () => {
      it("renames directly when the file is on the main drive", async () => {
         superExists.mockResolvedValue(true);

         await service.rename("/cloud/a.txt", "/cloud/b.txt");

         expect(superRename).toHaveBeenCalledWith("/cloud/a.txt", "/cloud/b.txt");
         expect(repo.findOne).not.toHaveBeenCalled();
      });

      it("promotes a cold file back to the main drive, then renames", async () => {
         const file = dyn({ path: "/cloud/a.txt" });
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await service.rename("/cloud/a.txt", "/cloud/b.txt");

         // first the promotion rename, then the user-requested rename
         expect(superRename).toHaveBeenNthCalledWith(1, coldPathOf(file), "/cloud/a.txt");
         expect(superRename).toHaveBeenNthCalledWith(2, "/cloud/a.txt", "/cloud/b.txt");
      });
   });

   describe("unlink", () => {
      it("deletes a hot file and clears any cold-storage index entry", async () => {
         superExists.mockResolvedValue(true); // on main drive
         const file = dyn();
         repo.findOne.mockResolvedValue(file);

         await service.unlink("/cloud/file.txt");

         expect(superUnlink).toHaveBeenCalledWith("/cloud/file.txt");
         expect(repo.remove).toHaveBeenCalledWith(file);
      });

      it("deletes a cold file at its cold path", async () => {
         const file = dyn();
         // not on main; resolves to cold path via getPath
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));
         repo.findOne.mockResolvedValue(file);

         await service.unlink(file.path);

         expect(superUnlink).toHaveBeenCalledWith(coldPathOf(file));
      });
   });

   describe("readdir", () => {
      it("merges cold-storage files into the directory listing using their basenames", async () => {
         superReaddir.mockResolvedValue([
            { name: "hot.txt", isFile: () => true, isDirectory: () => false },
         ] as any);
         repo.createQueryBuilder.mockReturnValue(
            queryBuilderReturning([dyn({ path: "/cloud/cold.txt", id: "c1" })]),
         );

         const entries = await service.readdir("/cloud");
         const names = entries.map((e: any) => e.name);

         expect(names).toContain("hot.txt");
         expect(names).toContain("cold.txt"); // basename, not the cold path
      });

      it("returns only main-drive entries when there are no cold files", async () => {
         superReaddir.mockResolvedValue([
            { name: "hot.txt", isFile: () => true, isDirectory: () => false },
         ] as any);
         repo.createQueryBuilder.mockReturnValue(queryBuilderReturning([]));

         const entries = await service.readdir("/cloud");

         expect(entries.map((e: any) => e.name)).toEqual(["hot.txt"]);
      });
   });

   describe("rmdir", () => {
      it("removes the directory, deletes cold files on disk, and clears their index entries", async () => {
         const coldFiles = [dyn({ id: "c1", path: "/cloud/sub/a.txt" }), dyn({ id: "c2", path: "/cloud/sub/b.txt" })];
         repo.createQueryBuilder.mockReturnValue(queryBuilderReturning(coldFiles));

         await service.rmdir("/cloud/sub", { recursive: true });

         expect(superRmdir).toHaveBeenCalledWith("/cloud/sub", { recursive: true });
         expect(superUnlink).toHaveBeenCalledWith(coldPathOf(coldFiles[0]));
         expect(superUnlink).toHaveBeenCalledWith(coldPathOf(coldFiles[1]));
         expect(repo.remove).toHaveBeenCalledWith(coldFiles);
      });
   });

   describe("stat", () => {
      it("stats the cold path when the file is not on the main drive", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await service.stat(file.path);

         expect(superStat).toHaveBeenCalledWith(coldPathOf(file));
      });

      it("stats the original path when the file is on the main drive", async () => {
         superExists.mockResolvedValue(true);

         await service.stat("/cloud/file.txt");

         expect(superStat).toHaveBeenCalledWith("/cloud/file.txt");
      });
   });

   describe("metrics", () => {
      let metrics: {
         coldStorageAccesses: number;
         hotStorageAccesses: number;
         coldStoragePromotions: number;
         coldStorageFileCount: number;
      };
      let svc: DynamicFileSystemService;

      beforeEach(() => {
         metrics = { coldStorageAccesses: 0, hotStorageAccesses: 0, coldStoragePromotions: 0, coldStorageFileCount: 0 };
         svc = new DynamicFileSystemService(repo as any, config as any, featureFlag as any, metrics as any);
      });

      it("counts a hot access (no promotion) when reading a file on the main drive", async () => {
         superExists.mockResolvedValue(true);

         await svc.readFile("/cloud/file.txt", "utf-8");

         expect(metrics.hotStorageAccesses).toBe(1);
         expect(metrics.coldStorageAccesses).toBe(0);
         expect(metrics.coldStoragePromotions).toBe(0);
      });

      it("counts a cold access and a promotion when reading a cold file", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await svc.readFile(file.path, "utf-8");

         expect(metrics.coldStorageAccesses).toBe(1);
         expect(metrics.hotStorageAccesses).toBe(0);
         expect(metrics.coldStoragePromotions).toBe(1);
      });

      it("counts a cold access and a promotion when streaming a cold file", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         await svc.createReadStream(file.path);

         expect(metrics.coldStorageAccesses).toBe(1);
         expect(metrics.coldStoragePromotions).toBe(1);
      });

      it("does not double-count a promotion when the cold file is missing on disk", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         // Not on main AND not at the cold path → nothing to move
         superExists.mockResolvedValue(false);

         await svc.readFile(file.path, "utf-8");

         expect(metrics.coldStorageAccesses).toBe(1);
         expect(metrics.coldStoragePromotions).toBe(0);
      });

      it("publishes the cold file count gauge from the repository", async () => {
         repo.count.mockResolvedValue(42);

         await svc.updateColdStorageGauge();

         expect(metrics.coldStorageFileCount).toBe(42);
      });

      it("is a no-op (no throw) when no metrics service is wired in", async () => {
         superExists.mockResolvedValue(true);
         const noMetrics = new DynamicFileSystemService(repo as any, config as any, featureFlag as any);

         await expect(noMetrics.readFile("/cloud/file.txt", "utf-8")).resolves.toBe("data");
         await expect(noMetrics.updateColdStorageGauge()).resolves.toBeUndefined();
      });
   });

   describe("cross-device promotion", () => {
      it("falls back to copy + delete when rename crosses filesystems (EXDEV)", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));

         const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
         superRename.mockRejectedValue(exdev);
         const copyFile = jest.spyOn(fs.promises, "copyFile").mockResolvedValue(undefined);
         const unlink = jest.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);

         await service.readFile(file.path, "utf-8");

         expect(superRename).toHaveBeenCalledWith(coldPathOf(file), file.path);
         expect(copyFile).toHaveBeenCalledWith(coldPathOf(file), file.path);
         expect(unlink).toHaveBeenCalledWith(coldPathOf(file));
         expect(repo.remove).toHaveBeenCalledWith(file);
      });

      it("propagates non-EXDEV rename errors", async () => {
         const file = dyn();
         repo.findOne.mockResolvedValue(file);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(file));
         superRename.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
         const copyFile = jest.spyOn(fs.promises, "copyFile").mockResolvedValue(undefined);

         await expect(service.readFile(file.path, "utf-8")).rejects.toThrow("permission denied");
         expect(copyFile).not.toHaveBeenCalled();
      });
   });

   describe("demoteStaleFiles (daily sweep)", () => {
      const STALE = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // ~6.5 months ago
      const FRESH = new Date();
      const BIG = 5 * 1024 * 1024;
      const fileEntry = (name: string) => ({ name, isFile: () => true, isDirectory: () => false });

      beforeEach(() => {
         // Configured cold drive "coldhdd" reports free space.
         jest.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 1_000_000, bsize: 4096 } as any);
      });

      it("demotes a stale, large file and records demotion metrics", async () => {
         const metrics = { coldStorageDemotions: 0, coldStorageBytesMoved: 0, coldStorageDemotionErrors: 0, coldStorageLastSweepMs: 0 };
         const svc = new DynamicFileSystemService(repo as any, config as any, featureFlag as any, metrics as any);
         superReaddir.mockResolvedValue([fileEntry("big.bin")] as any);
         superStat.mockResolvedValue({ atime: STALE, size: BIG } as any);

         await svc.demoteStaleFiles();

         expect(repo.save).toHaveBeenCalledTimes(1);
         const saved = repo.save.mock.calls[0][0];
         expect(saved.path).toBe("/cloud/big.bin");
         expect(saved.driveName).toBe("coldhdd");
         expect(superRename).toHaveBeenCalledWith("/cloud/big.bin", `/mnt/coldhdd/cloud-dir/${saved.id}`);
         expect(metrics.coldStorageDemotions).toBe(1);
         expect(metrics.coldStorageBytesMoved).toBe(BIG);
         expect(metrics.coldStorageDemotionErrors).toBe(0);
      });

      it("does not demote a recently-accessed file", async () => {
         superReaddir.mockResolvedValue([fileEntry("recent.bin")] as any);
         superStat.mockResolvedValue({ atime: FRESH, size: BIG } as any);

         await service.demoteStaleFiles();

         expect(repo.save).not.toHaveBeenCalled();
         expect(superRename).not.toHaveBeenCalled();
      });

      it("does not demote a stale but small file", async () => {
         superReaddir.mockResolvedValue([fileEntry("tiny.txt")] as any);
         superStat.mockResolvedValue({ atime: STALE, size: 100 } as any);

         await service.demoteStaleFiles();

         expect(repo.save).not.toHaveBeenCalled();
      });

      it("skips entirely when the dynamic_file_system flag is disabled", async () => {
         featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
         superReaddir.mockResolvedValue([fileEntry("big.bin")] as any);

         await service.demoteStaleFiles();

         expect(superReaddir).not.toHaveBeenCalled();
         expect(repo.save).not.toHaveBeenCalled();
      });

      it("skips when no cold drive is configured", async () => {
         (config.get as jest.Mock).mockImplementation((key: string) =>
            key === "this-service.cloud-dir" ? "/cloud" : { drives: [] },
         );
         superReaddir.mockResolvedValue([fileEntry("big.bin")] as any);
         superStat.mockResolvedValue({ atime: STALE, size: BIG } as any);

         await service.demoteStaleFiles();

         expect(repo.save).not.toHaveBeenCalled();
      });

      it("counts an error (without aborting the sweep) when a move fails", async () => {
         const metrics = { coldStorageDemotions: 0, coldStorageBytesMoved: 0, coldStorageDemotionErrors: 0, coldStorageLastSweepMs: 0 };
         const svc = new DynamicFileSystemService(repo as any, config as any, featureFlag as any, metrics as any);
         superReaddir.mockResolvedValue([fileEntry("big.bin")] as any);
         superStat.mockResolvedValue({ atime: STALE, size: BIG } as any);
         superRename.mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

         await svc.demoteStaleFiles();

         expect(metrics.coldStorageDemotionErrors).toBe(1);
         expect(metrics.coldStorageDemotions).toBe(0);
      });
   });

   describe("drainColdStorage", () => {
      it("moves every cold file back to the main drive and clears the index", async () => {
         const a = dyn({ id: "a", path: "/cloud/a.bin", driveName: "coldhdd" });
         const b = dyn({ id: "b", path: "/cloud/b.bin", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([a, b]);
         superExists.mockResolvedValue(true); // both cold copies present

         const result = await service.drainColdStorage();

         expect(superRename).toHaveBeenCalledWith(coldPathOf(a), a.path);
         expect(superRename).toHaveBeenCalledWith(coldPathOf(b), b.path);
         expect(repo.remove).toHaveBeenCalledWith(a);
         expect(repo.remove).toHaveBeenCalledWith(b);
         expect(result).toEqual({ moved: 2, errors: 0 });
      });

      it("drops dangling index rows when the cold copy is already gone", async () => {
         const a = dyn({ id: "a", path: "/cloud/a.bin", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([a]);
         superExists.mockResolvedValue(false); // cold copy missing

         const result = await service.drainColdStorage();

         expect(superRename).not.toHaveBeenCalled();
         expect(repo.remove).toHaveBeenCalledWith(a); // dangling row cleaned up
         expect(result.moved).toBe(0);
         expect(result.errors).toBe(1);
      });

      it("is a no-op when nothing is in cold storage", async () => {
         repo.find = jest.fn().mockResolvedValue([]);

         const result = await service.drainColdStorage();

         expect(result).toEqual({ moved: 0, errors: 0 });
         expect(superRename).not.toHaveBeenCalled();
      });
   });

   describe("reconcileIndex (DB/disk drift)", () => {
      it("keeps a valid cold-only row untouched", async () => {
         const row = dyn({ id: "v", path: "/cloud/v.txt", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([row]);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(row)); // cold only

         const result = await service.reconcileIndex();

         expect(repo.remove).not.toHaveBeenCalled();
         expect(result.pruned).toBe(0);
      });

      it("prunes a stale row (file is actually on the main drive)", async () => {
         const row = dyn({ id: "s", path: "/cloud/s.txt", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([row]);
         superExists.mockImplementation(async (p: string) => p === row.path); // main only

         const result = await service.reconcileIndex();

         expect(repo.remove).toHaveBeenCalledWith(row);
         expect(result.pruned).toBe(1);
      });

      it("prunes a dangling row (file on neither drive)", async () => {
         const row = dyn({ id: "d", path: "/cloud/d.txt", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([row]);
         superExists.mockResolvedValue(false); // neither

         const result = await service.reconcileIndex();

         expect(repo.remove).toHaveBeenCalledWith(row);
         expect(result.pruned).toBe(1);
      });

      it("prunes a conflicting row (file on both drives, main wins)", async () => {
         const row = dyn({ id: "c", path: "/cloud/c.txt", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([row]);
         superExists.mockResolvedValue(true); // both

         const result = await service.reconcileIndex();

         expect(repo.remove).toHaveBeenCalledWith(row);
         expect(result.pruned).toBe(1);
      });

      it("prunes only the inconsistent rows in a mixed set", async () => {
         const valid = dyn({ id: "v", path: "/cloud/v.txt", driveName: "coldhdd" });
         const dangling = dyn({ id: "d", path: "/cloud/d.txt", driveName: "coldhdd" });
         repo.find = jest.fn().mockResolvedValue([valid, dangling]);
         superExists.mockImplementation(async (p: string) => p === coldPathOf(valid)); // only valid's cold copy exists

         const result = await service.reconcileIndex();

         expect(result.pruned).toBe(1);
         expect(repo.remove).toHaveBeenCalledWith(dangling);
         expect(repo.remove).not.toHaveBeenCalledWith(valid);
      });
   });
});
