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

/**
 * Wraps NodeFileSystemService and tracks bytes read/written for metrics.
 */
@Injectable()
export class InstrumentedFileSystemService extends AbstractFileSystem {
   constructor(
      private readonly inner: NodeFileSystemService,
      @Optional() @Inject(MetricsPusherService) private readonly metrics?: MetricsPusherService,
   ) {
      super();
   }

   private trackRead(bytes: number) { if (this.metrics) this.metrics.fsBytesRead += bytes; }
   private trackWrite(bytes: number) { if (this.metrics) this.metrics.fsBytesWritten += bytes; }

   writeFileSync(path: string, content: string | NodeJS.ArrayBufferView): void {
      this.inner.writeFileSync(path, content);
      this.trackWrite(Buffer.byteLength(content as any));
   }

   readFileSync(path: string, encoding: BufferEncoding): string | Buffer {
      const result = this.inner.readFileSync(path, encoding);
      this.trackRead(Buffer.byteLength(result as any));
      return result;
   }

   existsSync(path: string): boolean { return this.inner.existsSync(path); }
   renameSync(path: string, newPath: string): void { this.inner.renameSync(path, newPath); }
   unlinkSync(path: string): void { this.inner.unlinkSync(path); }

   createReadStream(path: PathLike, options?: BufferEncoding): Readable {
      const stream = this.inner.createReadStream(path, options);
      const tracker = new PassThrough();
      tracker.on("data", (chunk: Buffer) => this.trackRead(chunk.length));
      return stream.pipe(tracker);
   }

   createWriteStream(path: PathLike, options?: BufferEncoding): Writable {
      const inner = this.inner.createWriteStream(path, options);
      const origWrite = inner.write.bind(inner);
      const self = this;
      inner.write = function (chunk: any, ...args: any[]) {
         if (chunk) self.trackWrite(Buffer.byteLength(chunk));
         return origWrite(chunk, ...args);
      } as any;
      return inner;
   }

   mkdirSync(path: string, options?: MakeDirectoryOptions): void { this.inner.mkdirSync(path, options); }
   rmdirSync(path: string, options?: { recursive: boolean }): void { this.inner.rmdirSync(path, options); }

   appendFileSync(path: string, content: string): void {
      this.inner.appendFileSync(path, content);
      this.trackWrite(Buffer.byteLength(content));
   }

   readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | null }): Dirent[] {
      return this.inner.readdirSync(path, options);
   }

   statSync(path: string): State { return this.inner.statSync(path); }
   lstatSync(path: string): State { return this.inner.lstatSync(path); }
}
