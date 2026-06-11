import { Injectable, Inject, Optional } from "@nestjs/common";
import {
   AbstractFileSystem,
   type Dirent,
   type MakeDirectoryOptions,
   type PathLike,
   type State,
} from "./abstract-file-system.interface";
import { type Readable, type Writable, PassThrough } from "stream";
import { MetricsPusherService } from "../metrics-pusher.service";
import { NodeFileSystemService } from "./file-system.service";
import { TieredStorageService } from "./tiered-storage.service";

/**
 * Wraps NodeFileSystemService and records filesystem metrics: bytes read/written,
 * per-operation latency, and read/write/meta operation counts. Also signals file access
 * to the tiered-storage service so cold files can be promoted back to the main drive.
 */
@Injectable()
export class InstrumentedFileSystemService extends AbstractFileSystem {
   constructor(
      private readonly inner: NodeFileSystemService,
      @Optional() @Inject(MetricsPusherService) private readonly metrics?: MetricsPusherService,
      @Optional() @Inject(TieredStorageService) private readonly tiered?: TieredStorageService,
   ) {
      super();
   }

   private trackRead(bytes: number) { if (this.metrics) this.metrics.fsBytesRead += bytes; }
   private trackWrite(bytes: number) { if (this.metrics) this.metrics.fsBytesWritten += bytes; }

   /** Times a single (synchronous) filesystem operation and records its latency + op count. */
   private measure<T>(op: string, kind: "read" | "write" | "meta", fn: () => T): T {
      if (!this.metrics) return fn();
      const start = performance.now();
      try {
         return fn();
      } finally {
         this.metrics.recordFsOp(op, Math.round((performance.now() - start) * 100) / 100, kind);
      }
   }

   writeFileSync(path: string, content: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding): void {
      this.measure("writeFile", "write", () => this.inner.writeFileSync(path, content, encoding));
      this.trackWrite(Buffer.byteLength(content as any));
      this.tiered?.onAccess(path);
   }

   readFileSync(path: string, encoding: BufferEncoding): string | Buffer {
      const result = this.measure("readFile", "read", () => this.inner.readFileSync(path, encoding));
      this.trackRead(Buffer.byteLength(result as any));
      this.tiered?.onAccess(path);
      return result;
   }

   existsSync(path: string): boolean { return this.measure("exists", "meta", () => this.inner.existsSync(path)); }
   renameSync(path: string, newPath: string): void { this.measure("rename", "write", () => this.inner.renameSync(path, newPath)); }
   unlinkSync(path: string): void { this.measure("unlink", "write", () => this.inner.unlinkSync(path)); }

   createReadStream(path: PathLike, options?: BufferEncoding): Readable {
      const stream = this.measure("createReadStream", "read", () => this.inner.createReadStream(path, options));
      const tracker = new PassThrough();
      tracker.on("data", (chunk: Buffer) => this.trackRead(chunk.length));
      this.tiered?.onAccess(path.toString());
      return stream.pipe(tracker);
   }

   createWriteStream(path: PathLike, options?: BufferEncoding): Writable {
      const inner = this.measure("createWriteStream", "write", () => this.inner.createWriteStream(path, options));
      const origWrite = inner.write.bind(inner);
      const self = this;
      inner.write = function (chunk: any, ...args: any[]) {
         if (chunk) self.trackWrite(Buffer.byteLength(chunk));
         return origWrite(chunk, ...args);
      } as any;
      return inner;
   }

   mkdirSync(path: string, options?: MakeDirectoryOptions): void { this.measure("mkdir", "meta", () => this.inner.mkdirSync(path, options)); }
   rmdirSync(path: string, options?: { recursive: boolean }): void { this.measure("rmdir", "write", () => this.inner.rmdirSync(path, options)); }

   appendFileSync(path: string, content: string): void {
      this.measure("appendFile", "write", () => this.inner.appendFileSync(path, content));
      this.trackWrite(Buffer.byteLength(content));
      this.tiered?.onAccess(path);
   }

   readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | null }): Dirent[] {
      return this.measure("readdir", "read", () => this.inner.readdirSync(path, options));
   }

   statSync(path: string): State { return this.measure("stat", "meta", () => this.inner.statSync(path)); }
   lstatSync(path: string): State { return this.measure("lstat", "meta", () => this.inner.lstatSync(path)); }
}
