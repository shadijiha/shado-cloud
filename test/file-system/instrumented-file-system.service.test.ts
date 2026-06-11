import { InstrumentedFileSystemService } from "src/file-system/instrumented-file-system.service";

/**
 * Verifies that InstrumentedFileSystemService records operation latency + counts and
 * byte throughput, delegating the actual work to its inner filesystem.
 *
 * onModuleInit() (which swaps the inner implementation based on a feature flag) is not
 * called, so `inner` stays as the injected `fs` mock.
 */
describe("InstrumentedFileSystemService - metrics", () => {
   let fsMock: Record<string, jest.Mock>;
   let metrics: {
      fsBytesRead: number;
      fsBytesWritten: number;
      fsReadOps: number;
      fsWriteOps: number;
      recordFsOp: jest.Mock;
   };
   let service: InstrumentedFileSystemService;

   beforeEach(() => {
      fsMock = {
         readFile: jest.fn().mockResolvedValue("abc"),
         writeFile: jest.fn().mockResolvedValue(undefined),
         appendFile: jest.fn().mockResolvedValue(undefined),
         exists: jest.fn().mockResolvedValue(true),
         stat: jest.fn().mockResolvedValue({ size: 1 }),
         readdir: jest.fn().mockResolvedValue([]),
         rename: jest.fn().mockResolvedValue(undefined),
         unlink: jest.fn().mockResolvedValue(undefined),
      };

      metrics = {
         fsBytesRead: 0,
         fsBytesWritten: 0,
         fsReadOps: 0,
         fsWriteOps: 0,
         // Mirror the real recordFsOp so we can assert the derived counters too.
         recordFsOp: jest.fn(function (this: void, _op: string, _ms: number, kind: string) {
            if (kind === "read") metrics.fsReadOps++;
            else if (kind === "write") metrics.fsWriteOps++;
         }),
      };

      service = new InstrumentedFileSystemService(
         fsMock as any, // inner fs
         {} as any,     // dynamic fs (unused without onModuleInit)
         {} as any,     // feature flag (unused without onModuleInit)
         metrics as any,
      );
   });

   it("records a read op with latency and byte count for readFile", async () => {
      const result = await service.readFile("/f.txt", "utf-8");

      expect(result).toBe("abc");
      expect(fsMock.readFile).toHaveBeenCalledWith("/f.txt", "utf-8");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("readFile", expect.any(Number), "read");
      expect(metrics.fsReadOps).toBe(1);
      expect(metrics.fsBytesRead).toBe(Buffer.byteLength("abc"));
   });

   it("records a write op with latency and byte count for writeFile", async () => {
      await service.writeFile("/f.txt", "hello");

      expect(fsMock.writeFile).toHaveBeenCalled();
      expect(metrics.recordFsOp).toHaveBeenCalledWith("writeFile", expect.any(Number), "write");
      expect(metrics.fsWriteOps).toBe(1);
      expect(metrics.fsBytesWritten).toBe(Buffer.byteLength("hello"));
   });

   it("records appendFile as a write op and counts the appended bytes", async () => {
      await service.appendFile("/f.txt", "xyz");

      expect(metrics.recordFsOp).toHaveBeenCalledWith("appendFile", expect.any(Number), "write");
      expect(metrics.fsBytesWritten).toBe(Buffer.byteLength("xyz"));
   });

   it("classifies metadata operations as the 'meta' kind", async () => {
      await service.stat("/f.txt");
      await service.exists("/f.txt");

      expect(metrics.recordFsOp).toHaveBeenCalledWith("stat", expect.any(Number), "meta");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("exists", expect.any(Number), "meta");
      // meta ops are not counted as reads or writes
      expect(metrics.fsReadOps).toBe(0);
      expect(metrics.fsWriteOps).toBe(0);
   });

   it("still records latency when the underlying op throws", async () => {
      fsMock.readFile.mockRejectedValue(new Error("disk error"));

      await expect(service.readFile("/f.txt", "utf-8")).rejects.toThrow("disk error");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("readFile", expect.any(Number), "read");
   });

   it("works without a metrics service (does not throw, still delegates)", async () => {
      const noMetrics = new InstrumentedFileSystemService(fsMock as any, {} as any, {} as any, undefined);

      await expect(noMetrics.readFile("/f.txt", "utf-8")).resolves.toBe("abc");
      expect(fsMock.readFile).toHaveBeenCalled();
   });
});

describe("InstrumentedFileSystemService - backend swap & cold-storage drain", () => {
   let fsMock: Record<string, jest.Mock>;
   let dynFs: { readFile: jest.Mock; drainColdStorage: jest.Mock; reconcileIndex: jest.Mock };
   let featureFlag: {
      isFeatureFlagEnabled: jest.Mock;
      addEventListener: jest.Mock;
   };
   let listener: () => Promise<void>;
   let service: InstrumentedFileSystemService;

   beforeEach(() => {
      fsMock = { readFile: jest.fn().mockResolvedValue("from-main") };
      dynFs = {
         readFile: jest.fn().mockResolvedValue("from-cold-aware"),
         drainColdStorage: jest.fn().mockResolvedValue({ moved: 0, errors: 0 }),
         reconcileIndex: jest.fn().mockResolvedValue({ pruned: 0 }),
      };
      featureFlag = {
         isFeatureFlagEnabled: jest.fn().mockResolvedValue(false),
         addEventListener: jest.fn().mockImplementation((_ns, _key, _id, fn) => { listener = fn; }),
      };
      service = new InstrumentedFileSystemService(fsMock as any, dynFs as any, featureFlag as any, undefined);
   });

   it("drains cold storage on boot when the flag is disabled, then serves from the plain FS", async () => {
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);

      await service.onModuleInit();

      expect(dynFs.drainColdStorage).toHaveBeenCalledTimes(1); // boot always repatriates leftovers
      await service.readFile("/f.txt", "utf-8");
      expect(fsMock.readFile).toHaveBeenCalled();
      expect(dynFs.readFile).not.toHaveBeenCalled();
   });

   it("uses the dynamic FS on boot when the flag is enabled (reconciles, no drain)", async () => {
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(true);

      await service.onModuleInit();

      expect(dynFs.drainColdStorage).not.toHaveBeenCalled();
      expect(dynFs.reconcileIndex).toHaveBeenCalledTimes(1);
      await service.readFile("/f.txt", "utf-8");
      expect(dynFs.readFile).toHaveBeenCalled();
   });

   it("converges to the plain FS when the flag is toggled OFF directly in the DB (no event fires)", async () => {
      // Boot enabled -> dynamic backend active.
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(true);
      await service.onModuleInit();
      await service.readFile("/f.txt", "utf-8");
      expect(dynFs.readFile).toHaveBeenCalledTimes(1);

      // Someone flips the flag straight in the DB — no listener fires. The periodic
      // syncBackend() tick (driven here directly) must still react.
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
      await service.syncBackend(); // simulates the @Cron tick

      expect(dynFs.drainColdStorage).toHaveBeenCalledTimes(1);
      await service.readFile("/f.txt", "utf-8");
      expect(fsMock.readFile).toHaveBeenCalledTimes(1); // now served from the plain FS
   });

   it("converges to the dynamic FS when the flag is toggled ON directly in the DB", async () => {
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
      await service.onModuleInit(); // plain FS

      featureFlag.isFeatureFlagEnabled.mockResolvedValue(true);
      await service.syncBackend();

      expect(dynFs.reconcileIndex).toHaveBeenCalledTimes(1);
      await service.readFile("/f.txt", "utf-8");
      expect(dynFs.readFile).toHaveBeenCalledTimes(1);
   });

   it("is a no-op on subsequent ticks when already in sync", async () => {
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(true);
      await service.onModuleInit();           // reconcile #1, inner = dynFs
      await service.syncBackend();             // already dynamic -> no-op
      await service.syncBackend();             // still no-op

      expect(dynFs.reconcileIndex).toHaveBeenCalledTimes(1);
      expect(dynFs.drainColdStorage).not.toHaveBeenCalled();
   });

   it("reacts immediately via the registered flag-change listener", async () => {
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(false);
      await service.onModuleInit();

      // Service-driven toggle: the flag is now true and the listener fires.
      featureFlag.isFeatureFlagEnabled.mockResolvedValue(true);
      await listener();

      expect(dynFs.reconcileIndex).toHaveBeenCalledTimes(1);
      await service.readFile("/f.txt", "utf-8");
      expect(dynFs.readFile).toHaveBeenCalledTimes(1);
   });
});
