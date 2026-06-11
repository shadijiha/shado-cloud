import { Injectable, Inject, Optional, OnModuleInit, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
   AbstractFileSystem,
   type MakeDirectoryOptions,
   type PathLike,
} from "./abstract-file-system.interface";
import { PassThrough } from "stream";
import { MetricsPusherService } from "../metrics-pusher.service";
import { NodeFileSystemService } from "./file-system.service";
import { DynamicFileSystemService } from "./dynamic-file-system.service";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

/**
 * Wraps NodeFileSystemService and tracks bytes read/written for metrics.
 */
@Injectable()
export class InstrumentedFileSystemService extends AbstractFileSystem implements OnModuleInit {
   private inner: AbstractFileSystem;
   private readonly logger = new Logger(InstrumentedFileSystemService.name);
   private syncing = false;
   
   constructor(
      @Inject() private readonly fs: NodeFileSystemService,
      @Inject() private readonly dynFs: DynamicFileSystemService,
      @Inject() private readonly featureFlag: FeatureFlagService,
      @Optional() @Inject(MetricsPusherService) private readonly metrics?: MetricsPusherService,
   ) {
      super();
      this.inner = this.fs;
   }

   async onModuleInit() {
      // Boot: align the backend with the flag and always repair physical state
      // (reconcile if enabled, repatriate leftovers if disabled).
      await this.syncBackend(true);

      // Fast path: react immediately when the flag is toggled via the service.
      this.featureFlag.addEventListener(FeatureFlagNamespace.Files, "dynamic_file_system", "swap_fs_type", async () => {
         await this.syncBackend();
      });
   }

   /**
    * Reconciles the active filesystem backend with the *current* value of the
    * dynamic_file_system flag. Runs on boot, on the flag-change event, and on a timer —
    * so the backend converges even when the flag is edited directly in the DB (which
    * fires no event listener). Transitions trigger the matching repair:
    *   off -> on : reconcileIndex() (heal DB/disk drift) before serving from the cold-aware FS
    *   on  -> off: drainColdStorage() (repatriate cold files) before serving from the plain FS
    */
   @Cron(CronExpression.EVERY_MINUTE)
   async syncBackend(isBoot = false): Promise<void> {
      if (this.syncing) return; // a sync is already in flight; skip this tick
      this.syncing = true;
      try {
         const enabled = await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, "dynamic_file_system");
         const currentlyDynamic = this.inner === this.dynFs;

         if (enabled) {
            if (currentlyDynamic && !isBoot) return; // already on the cold-aware backend
            this.logger.log("dynamic_file_system active — reconciling index and using the cold-aware filesystem");
            await this.dynFs.reconcileIndex();
            this.inner = this.dynFs;
         } else {
            if (!currentlyDynamic && !isBoot) return; // already on the plain backend (no leftovers at runtime)
            this.logger.log("dynamic_file_system inactive — draining cold storage and using the plain filesystem");
            await this.dynFs.drainColdStorage();
            this.inner = this.fs;
         }
      } catch (e) {
         this.logger.error(`Failed to sync filesystem backend with feature flag: ${(e as Error).message}`);
      } finally {
         this.syncing = false;
      }
   }

   private trackRead(bytes: number) { if (this.metrics) this.metrics.fsBytesRead += bytes; }
   private trackWrite(bytes: number) { if (this.metrics) this.metrics.fsBytesWritten += bytes; }

   /** Times a single filesystem operation and records its latency + op count. */
   private async measure<T>(op: string, kind: "read" | "write" | "meta", fn: () => Promise<T>): Promise<T> {
      if (!this.metrics) return fn();
      const start = performance.now();
      try {
         return await fn();
      } finally {
         this.metrics.recordFsOp(op, Math.round((performance.now() - start) * 100) / 100, kind);
      }
   }

   async writeFile(path: string, content: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding): Promise<void> {
      await this.measure("writeFile", "write", () => this.inner.writeFile(path, content, encoding));
      this.trackWrite(Buffer.byteLength(content as any));
   }

   async readFile(path: string, encoding: BufferEncoding): Promise<string | Buffer> {
      const result = await this.measure("readFile", "read", () => this.inner.readFile(path, encoding));
      this.trackRead(Buffer.byteLength(result as any));
      return result;
   }

   async exists(path: string) { return this.measure("exists", "meta", () => this.inner.exists(path)); }
   async rename(path: string, newPath: string) { return this.measure("rename", "write", () => this.inner.rename(path, newPath)); }
   async unlink(path: string) { return this.measure("unlink", "write", () => this.inner.unlink(path)); }

   async createReadStream(path: PathLike, options?: BufferEncoding) {
      const stream = await this.measure("createReadStream", "read", () => this.inner.createReadStream(path, options));
      const tracker = new PassThrough();
      tracker.on("data", (chunk: Buffer) => this.trackRead(chunk.length));
      return stream.pipe(tracker);
   }

   async createWriteStream(path: PathLike, options?: BufferEncoding) {
      const inner = await this.measure("createWriteStream", "write", () => this.inner.createWriteStream(path, options));
      const origWrite = inner.write.bind(inner);
      const self = this;
      inner.write = function (chunk: any, ...args: any[]) {
         if (chunk) self.trackWrite(Buffer.byteLength(chunk));
         return origWrite(chunk, ...args);
      } as any;
      return inner;
   }

   async mkdir(path: string, options?: MakeDirectoryOptions) { return this.measure("mkdir", "meta", () => this.inner.mkdir(path, options)); }
   async rmdir(path: string, options?: { recursive: boolean }) { await this.measure("rmdir", "write", () => this.inner.rmdir(path, options)); }

   async appendFile(path: string, content: string) {
      await this.measure("appendFile", "write", () => this.inner.appendFile(path, content));
      this.trackWrite(Buffer.byteLength(content));
   }

   async readdir(path: PathLike, options?: { encoding?: BufferEncoding | null }) {
      return this.measure("readdir", "read", () => this.inner.readdir(path, options));
   }

   stat(path: string) { return this.measure("stat", "meta", () => this.inner.stat(path)); }
   lstat(path: string) { return this.measure("lstat", "meta", () => this.inner.lstat(path)); }
}
