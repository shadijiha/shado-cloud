import { TieredStorageService } from "src/file-system/tiered-storage.service";
import * as fs from "fs";

const dirent = (name: string, isDir = false): fs.Dirent =>
   ({ name, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false } as any);

describe("TieredStorageService", () => {
   let config: { get: jest.Mock };
   let featureFlag: { isFeatureFlagEnabled: jest.Mock; getPayload: jest.Mock };
   let redis: {
      getBuffer: jest.Mock; incr: jest.Mock; expire: jest.Mock; exists: jest.Mock;
      set: jest.Mock; del: jest.Mock; strlen: jest.Mock; scan: jest.Mock;
   };
   let metrics: {
      coldStorageDemotions: number;
      coldStorageBytesMoved: number;
      coldStorageDemotionErrors: number;
      coldStorageLastSweepMs: number;
      coldStorageLastSweepAt: number;
      coldStoragePromotions: number;
      coldStorageBytesPromoted: number;
      coldStoragePromotionErrors: number;
      hotStorageHits: number;
      hotStoragePromotions: number;
      hotStorageBytesCached: number;
      hotStorageErrors: number;
   };
   let service: TieredStorageService;

   const STALE = Date.now() - 200 * 24 * 60 * 60 * 1000; // ~6.5 months ago (atimeMs)
   const FRESH = Date.now();
   const BIG = 5 * 1024 * 1024;

   beforeEach(() => {
      config = {
         get: jest.fn().mockImplementation((key: string) => {
            if (key === "this-service.cloud-dir") return "/cloud";
            if (key === "this-service.cold-storage") return { drives: ["coldhdd"] };
            return undefined;
         }),
      };
      featureFlag = {
         isFeatureFlagEnabled: jest.fn().mockResolvedValue(true),
         getPayload: jest.fn().mockResolvedValue({ accessThreshold: 5, ttlSeconds: 3600, maxFileBytes: 5 * 1024 * 1024, frequencyWindowSeconds: 1800 }),
      };
      redis = {
         getBuffer: jest.fn().mockResolvedValue(null),
         incr: jest.fn().mockResolvedValue(1),
         expire: jest.fn().mockResolvedValue(1),
         exists: jest.fn().mockResolvedValue(0),
         set: jest.fn().mockResolvedValue("OK"),
         del: jest.fn().mockResolvedValue(1),
         strlen: jest.fn().mockResolvedValue(0),
         scan: jest.fn().mockResolvedValue(["0", []]),
      };
      metrics = {
         coldStorageDemotions: 0, coldStorageBytesMoved: 0, coldStorageDemotionErrors: 0,
         coldStorageLastSweepMs: 0, coldStorageLastSweepAt: 0,
         coldStoragePromotions: 0, coldStorageBytesPromoted: 0, coldStoragePromotionErrors: 0,
         hotStorageHits: 0, hotStoragePromotions: 0, hotStorageBytesCached: 0, hotStorageErrors: 0,
      };
      service = new TieredStorageService(config as any, featureFlag as any, redis as any, metrics as any);

      jest.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 1_000_000, bsize: 4096 } as any);
      jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => false } as any);
      jest.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined as any);
      jest.spyOn(fs.promises, "copyFile").mockResolvedValue(undefined);
      jest.spyOn(fs.promises, "symlink").mockResolvedValue(undefined);
      jest.spyOn(fs.promises, "rename").mockResolvedValue(undefined);
      jest.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
   });

   afterEach(() => jest.restoreAllMocks());

   describe("demoteStaleFiles", () => {
      it("demotes a stale, large file: copies to cold then atomically replaces it with a symlink", async () => {
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("big.bin")] as any);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ atimeMs: STALE, size: BIG } as any);

         await service.demoteStaleFiles();

         const coldPath = "/mnt/coldhdd/cloud-dir/big.bin";
         expect(fs.promises.copyFile).toHaveBeenCalledWith("/cloud/big.bin", coldPath);
         expect(fs.promises.symlink).toHaveBeenCalledWith(coldPath, expect.stringContaining("/cloud/big.bin.tiering-"));
         expect(fs.promises.rename).toHaveBeenCalledWith(expect.stringContaining("/cloud/big.bin.tiering-"), "/cloud/big.bin");
         expect(metrics.coldStorageDemotions).toBe(1);
         expect(metrics.coldStorageBytesMoved).toBe(BIG);
         expect(metrics.coldStorageDemotionErrors).toBe(0);
         expect(metrics.coldStorageLastSweepAt).toBeGreaterThan(0);
      });

      it("skips a recently-accessed file", async () => {
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("recent.bin")] as any);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ atimeMs: FRESH, size: BIG } as any);

         await service.demoteStaleFiles();

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
         expect(metrics.coldStorageDemotions).toBe(0);
      });

      it("skips a stale but small file", async () => {
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("tiny.txt")] as any);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ atimeMs: STALE, size: 100 } as any);

         await service.demoteStaleFiles();

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
      });

      it("does nothing when the tiered_storage flag is disabled", async () => {
         featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
         const readdir = jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("big.bin")] as any);

         await service.demoteStaleFiles();

         expect(readdir).not.toHaveBeenCalled();
         expect(fs.promises.copyFile).not.toHaveBeenCalled();
      });

      it("does nothing when no cold drive is configured", async () => {
         (config.get as jest.Mock).mockImplementation((key: string) =>
            key === "this-service.cloud-dir" ? "/cloud" : { drives: [] },
         );
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("big.bin")] as any);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ atimeMs: STALE, size: BIG } as any);

         await service.demoteStaleFiles();

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
      });

      it("counts an error (without aborting) when a demotion fails", async () => {
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("big.bin")] as any);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ atimeMs: STALE, size: BIG } as any);
         (fs.promises.copyFile as jest.Mock).mockRejectedValue(new Error("disk full"));

         await service.demoteStaleFiles();

         expect(metrics.coldStorageDemotionErrors).toBe(1);
         expect(metrics.coldStorageDemotions).toBe(0);
      });
   });

   describe("promote-on-access (fire-and-forget)", () => {
      const COLD = "/mnt/coldhdd/cloud-dir/doc.txt";
      const promoteOnAccess = (p: string) => (service as any).promoteOnAccess(p) as Promise<void>;

      it("promotes a cold file when it is accessed", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true } as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue(COLD);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ size: 2048 } as any);

         await promoteOnAccess("/cloud/doc.txt");

         expect(fs.promises.copyFile).toHaveBeenCalledWith(COLD, expect.stringContaining("/cloud/doc.txt.promoting-"));
         expect(fs.promises.rename).toHaveBeenCalledWith(expect.stringContaining("/cloud/doc.txt.promoting-"), "/cloud/doc.txt");
         expect(fs.promises.rm).toHaveBeenCalledWith(COLD, { force: true });
         expect(metrics.coldStoragePromotions).toBe(1);
         expect(metrics.coldStorageBytesPromoted).toBe(2048);
      });

      it("is a no-op for a hot file (not a symlink) — without even checking the flag", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => false } as any);

         await promoteOnAccess("/cloud/hot.txt");

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
         expect(featureFlag.isFeatureFlagEnabled).not.toHaveBeenCalled();
         expect(metrics.coldStoragePromotions).toBe(0);
      });

      it("does not promote a symlink pointing outside cold storage", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true } as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue("/some/other/place/x");

         await promoteOnAccess("/cloud/link.txt");

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
      });

      it("does not promote when the promotion flag is disabled", async () => {
         featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true } as any);

         await promoteOnAccess("/cloud/doc.txt");

         expect(fs.promises.copyFile).not.toHaveBeenCalled();
      });

      it("counts a promotion error and never throws", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true } as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue(COLD);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ size: 10 } as any);
         (fs.promises.copyFile as jest.Mock).mockRejectedValue(new Error("io error"));

         await expect(promoteOnAccess("/cloud/doc.txt")).resolves.toBeUndefined();

         expect(metrics.coldStoragePromotionErrors).toBe(1);
         expect(metrics.coldStoragePromotions).toBe(0);
      });
   });

   describe("evacuateDrive", () => {
      it("migrates referenced cold files back to main and removes orphans", async () => {
         const link = { name: "ref.bin", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
         // /cloud has a cold symlink; /mnt/coldhdd/cloud-dir has a leftover orphan blob
         jest.spyOn(fs.promises, "readdir").mockImplementation(async (dir: any) => {
            if (String(dir) === "/cloud") return [link] as any;
            if (String(dir) === "/mnt/coldhdd/cloud-dir") return [dirent("orphan.bin")] as any;
            return [] as any;
         });
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true } as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue("/mnt/coldhdd/cloud-dir/ref.bin");
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ size: 100 } as any);

         const result = await service.evacuateDrive("coldhdd");

         expect(result.migrated).toBe(1);
         expect(result.orphansRemoved).toBe(1);
         expect(result.errors).toBe(0);
         // referenced file copied back + symlink replaced
         expect(fs.promises.copyFile).toHaveBeenCalledWith("/mnt/coldhdd/cloud-dir/ref.bin", expect.stringContaining("/cloud/ref.bin.promoting-"));
         // leftover orphan blob removed
         expect(fs.promises.rm).toHaveBeenCalledWith("/mnt/coldhdd/cloud-dir/orphan.bin", { force: true });
         expect(metrics.coldStoragePromotions).toBe(1);
         expect(metrics.coldStorageBytesPromoted).toBe(100);
      });

      it("is a no-op for an unknown (non-configured) drive", async () => {
         const readdir = jest.spyOn(fs.promises, "readdir");

         const result = await service.evacuateDrive("not-a-drive");

         expect(result).toEqual({ migrated: 0, bytes: 0, errors: 0, orphansRemoved: 0 });
         expect(readdir).not.toHaveBeenCalled();
      });
   });

   describe("removeColdData", () => {
      it("removes the cold blob backing a cold symlink", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false } as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue("/mnt/coldhdd/cloud-dir/x.png");

         await service.removeColdData("/cloud/x.png");

         expect(fs.promises.rm).toHaveBeenCalledWith("/mnt/coldhdd/cloud-dir/x.png", { force: true });
      });

      it("does nothing for a hot (non-symlink) file", async () => {
         jest.spyOn(fs.promises, "lstat").mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false } as any);

         await service.removeColdData("/cloud/hot.png");

         expect(fs.promises.rm).not.toHaveBeenCalled();
      });

      it("recurses into a directory and removes each cold blob", async () => {
         jest.spyOn(fs.promises, "lstat").mockImplementation(async (p: any) =>
            String(p) === "/cloud/d"
               ? ({ isSymbolicLink: () => false, isDirectory: () => true } as any)
               : ({ isSymbolicLink: () => true, isDirectory: () => false } as any),
         );
         jest.spyOn(fs.promises, "readdir").mockResolvedValue([dirent("a.png")] as any);
         jest.spyOn(fs.promises, "readlink").mockResolvedValue("/mnt/coldhdd/cloud-dir/d/a.png");

         await service.removeColdData("/cloud/d");

         expect(fs.promises.rm).toHaveBeenCalledWith("/mnt/coldhdd/cloud-dir/d/a.png", { force: true });
      });
   });

   describe("hot tier (Redis)", () => {
      it("getHotStream returns null when the hot flag is off", async () => {
         featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
         expect(await service.getHotStream("/cloud/a.png")).toBeNull();
         expect(redis.getBuffer).not.toHaveBeenCalled();
      });

      it("getHotStream returns a stream from Redis and refreshes the TTL (sliding)", async () => {
         redis.getBuffer.mockResolvedValue(Buffer.from("hello-bytes"));
         const stream = await service.getHotStream("/cloud/a.png");
         expect(stream).not.toBeNull();
         expect(redis.expire).toHaveBeenCalledWith("hot:blob:/cloud/a.png", 3600);
         expect(metrics.hotStorageHits).toBe(1);

         const chunks: Buffer[] = [];
         for await (const c of stream as NodeJS.ReadableStream) chunks.push(c as Buffer);
         expect(Buffer.concat(chunks).toString()).toBe("hello-bytes");
      });

      it("getHotStream slices the buffer for a byte range", async () => {
         redis.getBuffer.mockResolvedValue(Buffer.from("0123456789"));
         const stream = await service.getHotStream("/cloud/a.png", { start: 2, end: 4 });
         const chunks: Buffer[] = [];
         for await (const c of stream as NodeJS.ReadableStream) chunks.push(c as Buffer);
         expect(Buffer.concat(chunks).toString()).toBe("234");
      });

      it("recordServe promotes a file into Redis once it crosses the access threshold", async () => {
         redis.incr.mockResolvedValue(5); // == accessThreshold
         redis.exists.mockResolvedValue(0); // not cached yet
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ size: 1234 } as any);
         jest.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from("payload") as any);

         service.recordServe("/cloud/a.png");
         await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle

         expect(redis.set).toHaveBeenCalledWith("hot:blob:/cloud/a.png", expect.any(Buffer), "EX", 3600);
         expect(metrics.hotStoragePromotions).toBe(1);
         expect(metrics.hotStorageBytesCached).toBe(1234);
      });

      it("recordServe does not cache below the threshold", async () => {
         redis.incr.mockResolvedValue(2); // < threshold
         service.recordServe("/cloud/a.png");
         await new Promise((r) => setImmediate(r));
         expect(redis.set).not.toHaveBeenCalled();
      });

      it("recordServe skips files larger than maxFileBytes", async () => {
         redis.incr.mockResolvedValue(10);
         redis.exists.mockResolvedValue(0);
         jest.spyOn(fs.promises, "stat").mockResolvedValue({ size: 10 * 1024 * 1024 } as any); // > 5 MB
         service.recordServe("/cloud/big.bin");
         await new Promise((r) => setImmediate(r));
         expect(redis.set).not.toHaveBeenCalled();
      });

      it("removeHotData deletes the blob + counter and any subtree keys", async () => {
         redis.scan.mockResolvedValue(["0", []]);
         await service.removeHotData("/cloud/a.png");
         expect(redis.del).toHaveBeenCalledWith("hot:blob:/cloud/a.png", "hot:freq:/cloud/a.png");
      });

      it("isHotFile reflects the blob's existence in Redis", async () => {
         redis.exists.mockResolvedValue(1);
         expect(await service.isHotFile("/cloud/a.png")).toBe(true);
         redis.exists.mockResolvedValue(0);
         expect(await service.isHotFile("/cloud/a.png")).toBe(false);
      });

      it("hotStats counts cached blobs and sums their bytes", async () => {
         redis.scan.mockResolvedValueOnce(["0", ["hot:blob:/cloud/a.png", "hot:blob:/cloud/b.png"]]);
         redis.strlen.mockResolvedValueOnce(100).mockResolvedValueOnce(50);
         expect(await service.hotStats()).toEqual({ fileCount: 2, bytes: 150 });
      });
   });
});
