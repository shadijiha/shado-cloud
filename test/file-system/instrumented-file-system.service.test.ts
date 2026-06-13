import { InstrumentedFileSystemService } from "src/file-system/instrumented-file-system.service";
import { PassThrough } from "stream";

/**
 * InstrumentedFileSystemService is a synchronous metrics wrapper around
 * NodeFileSystemService: it records per-operation latency, read/write/meta op counts,
 * and bytes read/written, delegating the actual work to its inner filesystem.
 */
describe("InstrumentedFileSystemService - metrics", () => {
   let fsMock: Record<string, jest.Mock>;
   let metrics: {
      fsBytesRead: number;
      fsBytesWritten: number;
      fsReadOps: number;
      fsWriteOps: number;
      openFileStreams: number;
      recordFsOp: jest.Mock;
   };
   let service: InstrumentedFileSystemService;

   beforeEach(() => {
      fsMock = {
         readFileSync: jest.fn().mockReturnValue("abc"),
         writeFileSync: jest.fn(),
         appendFileSync: jest.fn(),
         existsSync: jest.fn().mockReturnValue(true),
         statSync: jest.fn().mockReturnValue({ size: 1 }),
         readdirSync: jest.fn().mockReturnValue([]),
         renameSync: jest.fn(),
         unlinkSync: jest.fn(),
         createReadStream: jest.fn().mockImplementation(() => new PassThrough()),
      };

      metrics = {
         fsBytesRead: 0,
         fsBytesWritten: 0,
         fsReadOps: 0,
         fsWriteOps: 0,
         openFileStreams: 0,
         recordFsOp: jest.fn(function (this: void, _op: string, _ms: number, kind: string) {
            if (kind === "read") metrics.fsReadOps++;
            else if (kind === "write") metrics.fsWriteOps++;
         }),
      };

      service = new InstrumentedFileSystemService(fsMock as any, metrics as any);
   });

   it("signals access to tiered storage on read/createReadStream", () => {
      const tiered = { onAccess: jest.fn() };
      const svc = new InstrumentedFileSystemService(fsMock as any, metrics as any, tiered as any);

      svc.readFileSync("/cloud/a.txt", "utf-8");
      svc.createReadStream("/cloud/b.txt");

      expect(tiered.onAccess).toHaveBeenCalledWith("/cloud/a.txt");
      expect(tiered.onAccess).toHaveBeenCalledWith("/cloud/b.txt");
   });

   it("destroys the source read stream when the consumer tears down (no fd/buffer leak)", async () => {
      const source = new PassThrough();
      fsMock.createReadStream.mockReturnValueOnce(source);

      const out = service.createReadStream("/cloud/b.txt");
      // Simulate the HTTP response/consumer going away mid-stream.
      out.destroy();
      // 'close' propagates on the next tick.
      await new Promise((r) => setImmediate(r));

      expect(source.destroyed).toBe(true);
   });

   it("tracks the live open-stream gauge: +1 on open, back to 0 on teardown", async () => {
      const source = new PassThrough();
      fsMock.createReadStream.mockReturnValueOnce(source);

      const out = service.createReadStream("/cloud/b.txt");
      expect(metrics.openFileStreams).toBe(1);

      out.destroy();
      await new Promise((r) => setImmediate(r));
      expect(metrics.openFileStreams).toBe(0);
   });

   it("destroys the tracker when the source stream errors", () => {
      const source = new PassThrough();
      fsMock.createReadStream.mockReturnValueOnce(source);

      const out = service.createReadStream("/cloud/b.txt");
      const onError = jest.fn();
      out.on("error", onError);

      source.emit("error", new Error("disk gone"));

      expect(out.destroyed).toBe(true);
   });

   it("records a read op with latency and byte count for readFileSync", () => {
      const result = service.readFileSync("/f.txt", "utf-8");

      expect(result).toBe("abc");
      expect(fsMock.readFileSync).toHaveBeenCalledWith("/f.txt", "utf-8");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("readFile", expect.any(Number), "read");
      expect(metrics.fsReadOps).toBe(1);
      expect(metrics.fsBytesRead).toBe(Buffer.byteLength("abc"));
   });

   it("records a write op with latency and byte count for writeFileSync", () => {
      service.writeFileSync("/f.txt", "hello");

      expect(fsMock.writeFileSync).toHaveBeenCalled();
      expect(metrics.recordFsOp).toHaveBeenCalledWith("writeFile", expect.any(Number), "write");
      expect(metrics.fsWriteOps).toBe(1);
      expect(metrics.fsBytesWritten).toBe(Buffer.byteLength("hello"));
   });

   it("records appendFileSync as a write op and counts the appended bytes", () => {
      service.appendFileSync("/f.txt", "xyz");

      expect(metrics.recordFsOp).toHaveBeenCalledWith("appendFile", expect.any(Number), "write");
      expect(metrics.fsBytesWritten).toBe(Buffer.byteLength("xyz"));
   });

   it("classifies metadata operations as the 'meta' kind", () => {
      service.statSync("/f.txt");
      service.existsSync("/f.txt");

      expect(metrics.recordFsOp).toHaveBeenCalledWith("stat", expect.any(Number), "meta");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("exists", expect.any(Number), "meta");
      expect(metrics.fsReadOps).toBe(0);
      expect(metrics.fsWriteOps).toBe(0);
   });

   it("still records latency when the underlying op throws", () => {
      fsMock.readFileSync.mockImplementation(() => { throw new Error("disk error"); });

      expect(() => service.readFileSync("/f.txt", "utf-8")).toThrow("disk error");
      expect(metrics.recordFsOp).toHaveBeenCalledWith("readFile", expect.any(Number), "read");
   });

   it("works without a metrics service (does not throw, still delegates)", () => {
      const noMetrics = new InstrumentedFileSystemService(fsMock as any, undefined);

      expect(noMetrics.readFileSync("/f.txt", "utf-8")).toBe("abc");
      expect(fsMock.readFileSync).toHaveBeenCalled();
   });
});
