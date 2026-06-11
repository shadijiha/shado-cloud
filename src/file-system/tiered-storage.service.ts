import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import type Redis from "ioredis";
import { EnvVariables } from "src/config/config.validator";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { REDIS_CACHE } from "src/util";
import { HOT_STORAGE_DEFAULT_CONFIG, type HotStorageConfig } from "src/admin/feature-flag-defaults";
import { MetricsPusherService } from "../metrics-pusher.service";

/**
 * Tiered storage via symbolic links.
 *
 * Files that haven't been accessed in a long time are moved off the main (fast) drive
 * onto a slower "cold" drive, and a symlink is left in their place. Because the kernel
 * resolves symlinks transparently, the rest of the app keeps using the ordinary
 * (synchronous) filesystem with no awareness of cold storage — reads, stats and
 * directory listings just work.
 *
 * The cold drive mirrors the main cloud-dir tree, so a file at
 *   <cloud-dir>/<rel>           (now a symlink)
 * points to
 *   /mnt/<drive>/cloud-dir/<rel> (the real bytes)
 *
 * This service only runs background jobs (demotion + GC); it is never on the request
 * path, so it can use async fs APIs internally without affecting the sync FS abstraction.
 */
@Injectable()
export class TieredStorageService {
   private readonly logger = new Logger(TieredStorageService.name);
   private readonly mountPattern = "/mnt/$drive_name";
   private readonly coldSubdir = "cloud-dir";

   // A file is eligible for demotion once it hasn't been accessed for ~6 months.
   private static readonly STALE_AFTER_MS = 10 * 1000; //6 * 30 * 24 * 60 * 60 * 1000;
   // Don't bother demoting tiny files — the move isn't worth the space reclaimed.
   private static readonly MIN_DEMOTE_SIZE_BYTES = /*1*/ 0.25 * 1024 * 1024; // 1 MB

   // Independent feature flags (namespace: Files) for each background behaviour.
   private static readonly DEMOTION_FLAG = "tiered_storage_demotion";
   private static readonly PROMOTION_FLAG = "tiered_storage_promotion";
   // Hot tier: cache frequently-served files entirely in Redis (configured via the flag payload).
   private static readonly HOT_FLAG = "tiered_storage_hot";

   // Redis key prefixes for the hot tier (all keys carry a TTL so Redis auto-evicts them).
   private static readonly HOT_BLOB_PREFIX = "hot:blob:"; // the file bytes
   private static readonly HOT_FREQ_PREFIX = "hot:freq:"; // per-file access counter

   private demoting = false;

   // Files currently being promoted (fire-and-forget on access), to dedup concurrent
   // promotions of the same path under a burst of reads.
   private readonly promoting = new Set<string>();

   constructor(
      @Inject() private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly featureFlag: FeatureFlagService,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      @Optional() @Inject(MetricsPusherService) private readonly metrics?: MetricsPusherService,
   ) {}

   /**
    * Daily sweep: move stale, large files off the main drive to a cold drive and leave a
    * symlink behind. Uses filesystem access time (atime) as the "last accessed" signal.
    */
   @Cron(CronExpression.EVERY_6_HOURS, { name: "tiered-storage:demote-stale" })
   public async demoteStaleFiles(): Promise<void> {
      if (this.demoting) return;
      if (!(await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.DEMOTION_FLAG))) return;

      const cloudDir = this.config.get("this-service.cloud-dir", { infer: true });
      if (!cloudDir) {
         this.logger.warn("Demotion skipped: cloud-dir is not configured");
         return;
      }

      const drive = await this.pickColdDrive();
      if (!drive) {
         this.logger.warn("Demotion skipped: no writable cold drive configured/reachable");
         return;
      }

      this.demoting = true;
      const coldRoot = this.coldRootFor(drive);
      const cutoff = Date.now() - TieredStorageService.STALE_AFTER_MS;
      const start = performance.now();
      let demoted = 0;
      let bytesMoved = 0;
      let errors = 0;

      try {
         for await (const file of this.walkRealFiles(cloudDir)) {
            try {
               const stat = await fs.promises.stat(file); // real file (symlinks are skipped by the walk)
               if (stat.atimeMs > cutoff) continue;                                  // accessed recently

               if (stat.size < TieredStorageService.MIN_DEMOTE_SIZE_BYTES) {
                  continue; // too small to bother
               }

               await this.demote(file, cloudDir, coldRoot);
               demoted++;
               bytesMoved += stat.size;
            } catch (e) {
               errors++;
               this.logger.error(`Failed to demote ${file}: ${(e as Error).message}`);
            }
         }
      } finally {
         this.demoting = false;
      }

      const elapsed = Math.round(performance.now() - start);
      this.logger.log(
         `Tiering sweep complete: demoted ${demoted} file(s), ` +
         `${(bytesMoved / 1e6).toFixed(2)} MB moved to "${drive}", ${errors} error(s), ${elapsed}ms`,
      );

      if (this.metrics) {
         this.metrics.coldStorageDemotions += demoted;
         this.metrics.coldStorageBytesMoved += bytesMoved;
         this.metrics.coldStorageDemotionErrors += errors;
         this.metrics.coldStorageLastSweepMs = elapsed;
         this.metrics.coldStorageLastSweepAt = Date.now();
      }
   }

   /**
    * Moves one file to the cold drive and atomically replaces it with a symlink.
    * Crash-safe: the original is only swapped for the symlink after the cold copy exists,
    * and a failure leaves the original intact (the stray cold copy is reclaimed by GC).
    */
   private async demote(absPath: string, cloudDir: string, coldRoot: string): Promise<void> {
      // Defensive: never demote a path that is already a symlink (handles TOCTOU between
      // the directory walk and this call, and any re-run).
      const lst = await fs.promises.lstat(absPath).catch(() => null);
      if (!lst || lst.isSymbolicLink()) return;

      const rel = path.relative(cloudDir, absPath);
      const coldPath = path.join(coldRoot, rel);
      // UUID temp name so a leftover temp link (e.g. from a process killed mid-demotion)
      // can never collide and cause EEXIST.
      const tmpLink = `${absPath}.tiering-${randomUUID()}`;

      await fs.promises.mkdir(path.dirname(coldPath), { recursive: true });
      await fs.promises.copyFile(absPath, coldPath); // copyFile works across devices

      try {
         await fs.promises.symlink(coldPath, tmpLink);
         await fs.promises.rename(tmpLink, absPath); // atomic: replaces the real file with the symlink
      } catch (e) {
         await fs.promises.rm(tmpLink, { force: true }).catch(() => undefined);
         await fs.promises.rm(coldPath, { force: true }).catch(() => undefined);
         throw e;
      }
   }


   /**
    * Called from the filesystem read path when a file is accessed. Fire-and-forget and
    * non-blocking: the read is served immediately (the kernel follows the symlink), and if
    * the file is cold it's promoted back to the main drive asynchronously in the background.
    */
   public onAccess(path: string): void {
      void this.promoteOnAccess(path);
   }

   /**
    * Background promotion for a single accessed path. Cheaply bails out for hot files
    * (non-symlinks) before any feature-flag/redis lookup, dedups concurrent promotions of
    * the same path, and never throws (it's fire-and-forget).
    */
   private async promoteOnAccess(path_: string): Promise<void> {
      if (this.promoting.has(path_)) return; // already promoting this file

      // Cheapest check first: only cold symlinks are promotable — avoids a flag lookup on hot files.
      let stat: import("fs").Stats;
      try {
         stat = await fs.promises.lstat(path_);
      } catch {
         return;
      }
      if (!stat.isSymbolicLink()) return;

      if (!(await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.PROMOTION_FLAG))) {
         return;
      }

      this.promoting.add(path_);
      try {
         const size = await this.promote(path_);
         if (size !== null) {
            this.logger.log(`Promoted ${path_} back to the main drive (${(size / 1e6).toFixed(2)} MB)`);
            if (this.metrics) {
               this.metrics.coldStoragePromotions += 1;
               this.metrics.coldStorageBytesPromoted += size;
            }
         }
      } catch (e) {
         if (this.metrics) this.metrics.coldStoragePromotionErrors += 1;
         this.logger.error(`Promote-on-access failed for ${path_}: ${(e as Error).message}`);
      } finally {
         this.promoting.delete(path_);
      }
   }

   /**
    * Promotes a single cold file back to the main drive: copy cold -> temp on main, then
    * atomically replace the symlink with the real file, then delete the cold blob. Returns
    * the bytes promoted, or null if `path` wasn't a cold symlink (already promoted/deleted).
    */
   private async promote(path_: string): Promise<number | null> {
      const stat = await fs.promises.lstat(path_).catch(() => null);
      if (!stat || !stat.isSymbolicLink()) return null; // not a cold file (anymore)

      const target = await fs.promises.readlink(path_);
      if (!this.isUnderColdMount(target)) return null;

      const size = (await fs.promises.stat(target)).size; // size of the cold blob
      const tmp = `${path_}.promoting-${process.pid}-${Date.now()}`;

      try {
         await fs.promises.copyFile(target, tmp);   // cold -> main (works across devices)
         await fs.promises.rename(tmp, path_);       // atomic: replace symlink with the real file
      } catch (e) {
         await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
         throw e;
      }

      // Real file is now on the main drive; drop the cold blob (GC would also reclaim it).
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
      return size;
   }

   /**
    * Migrates every file on a cold drive back to the main drive so the drive can be safely
    * ejected. Referenced cold files are promoted (copied back + symlink replaced); orphan
    * blobs are simply removed. Independent of the feature flags — it's a manual admin action.
    * Returns counts of what was migrated. Skips unknown (non-configured) drive names.
    */
   public async evacuateDrive(driveName: string): Promise<{ migrated: number; bytes: number; errors: number; orphansRemoved: number }> {
      const result = { migrated: 0, bytes: 0, errors: 0, orphansRemoved: 0 };
      if (!this.configuredDrives().includes(driveName)) {
         this.logger.warn(`Evacuation requested for unknown cold drive "${driveName}"`);
         return result;
      }

      const cloudDir = this.config.get("this-service.cloud-dir", { infer: true });
      if (!cloudDir) return result;

      const coldRoot = this.coldRootFor(driveName);
      this.logger.log(`Evacuating cold drive "${driveName}" -> main drive...`);

      // 1. Promote every cold symlink (anywhere in the cloud dir) that points to this drive.
      //    This follows the symlink target (readlink), so it's correct even after renames —
      //    it never assumes the cold blob mirrors the file's current path.
      for await (const link of this.walkSymlinks(cloudDir)) {
         try {
            const target = path.resolve(await fs.promises.readlink(link));
            if (!target.startsWith(coldRoot + path.sep)) continue; // points to a different drive
            const size = await this.promote(link); // copy back + replace symlink + drop the blob
            if (size !== null) {
               result.migrated++;
               result.bytes += size;
            }
         } catch (e) {
            result.errors++;
            this.logger.error(`Failed to migrate ${link}: ${(e as Error).message}`);
         }
      }

      // 2. Anything still on the drive is unreferenced (orphans from crashes/tampering) —
      //    remove it so the drive ends up empty and can be ejected.
      for await (const blob of this.walkRealFiles(coldRoot)) {
         try {
            await fs.promises.rm(blob, { force: true });
            result.orphansRemoved++;
         } catch (e) {
            result.errors++;
            this.logger.error(`Failed to remove leftover cold file ${blob}: ${(e as Error).message}`);
         }
      }

      this.logger.log(
         `Evacuated "${driveName}": migrated ${result.migrated} file(s) (${(result.bytes / 1e6).toFixed(2)} MB), ` +
         `removed ${result.orphansRemoved} orphan(s), ${result.errors} error(s)`,
      );
      if (this.metrics) {
         this.metrics.coldStoragePromotions += result.migrated;
         this.metrics.coldStorageBytesPromoted += result.bytes;
         this.metrics.coldStoragePromotionErrors += result.errors;
      }
      return result;
   }

   /****** Helpers ******/

   /**
    * Lightweight snapshot for the admin UI: whether tiering is on, and per configured
    * cold drive its mount point, current cold-file count and total cold bytes.
    * Walks the cold mirror trees on demand (cheap for the occasional admin page load).
    */
   public async getOverview(): Promise<{
      flags: { demotion: boolean; promotion: boolean; hot: boolean };
      hot: { fileCount: number; bytes: number; config: HotStorageConfig };
      drives: { name: string; mountPoint: string; coldFileCount: number; coldBytes: number; total: number; free: number; used: number }[];
   }> {
      const flags = {
         demotion: await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.DEMOTION_FLAG),
         promotion: await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.PROMOTION_FLAG),
         hot: await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.HOT_FLAG),
      };

      const hot = { ...(await this.hotStats()), config: await this.hotConfig() };

      const drives: { name: string; mountPoint: string; coldFileCount: number; coldBytes: number; total: number; free: number; used: number }[] = [];
      for (const name of this.configuredDrives()) {
         const coldRoot = this.coldRootFor(name);

         let coldFileCount = 0;
         let coldBytes = 0;
         for await (const coldFile of this.walkRealFiles(coldRoot)) {
            try {
               coldBytes += (await fs.promises.stat(coldFile)).size;
               coldFileCount++;
            } catch {
               // file vanished mid-walk — ignore
            }
         }

         // Disk usage of the cold drive (statfs the cold-dir, which lives on that mount).
         let total = 0;
         let free = 0;
         try {
            const st = await fs.promises.statfs(coldRoot);
            total = st.blocks * st.bsize;
            free = st.bavail * st.bsize;
         } catch {
            // mount not present yet — leave usage at 0
         }

         drives.push({ name, mountPoint: this.mountFor(name), coldFileCount, coldBytes, total, free, used: total - free });
      }

      return { flags, hot, drives };
   }


   /** Recursively yields real (non-symlink, non-hidden) files under `dir`. */
   private async *walkRealFiles(dir: string): AsyncGenerator<string> {
      let entries: fs.Dirent[];
      try {
         entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
         return; // unreadable / missing directory
      }

      for (const entry of entries) {
         // Skip hidden files and internal folders (e.g. .meta thumbnails, _system),
         // and symlinks (Dirent reflects lstat, so isFile() is false for a symlink).
         if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

         const full = path.join(dir, entry.name);
         if (entry.isDirectory()) {
            yield* this.walkRealFiles(full);
         } else if (entry.isFile()) {
            yield full;
         }
      }
   }

   /** Recursively yields every symlink (non-hidden) under `dir`. */
   private async *walkSymlinks(dir: string): AsyncGenerator<string> {
      let entries: fs.Dirent[];
      try {
         entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
         return;
      }

      for (const entry of entries) {
         if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
         const full = path.join(dir, entry.name);
         if (entry.isSymbolicLink()) {
            yield full;
         } else if (entry.isDirectory()) {
            yield* this.walkSymlinks(full);
         }
      }
   }

   /** Picks the configured cold drive with the most free space (mounted at /mnt/<name>). */
   private async pickColdDrive(): Promise<string | null> {
      const drives = this.configuredDrives();
      if (drives.length === 0) {
         this.logger.warn("No cold-storage drives configured (this-service.cold-storage.drives)");
         return null;
      }

      let best: { name: string; free: number } | null = null;
      for (const name of drives) {
         try {
            const stats = await fs.promises.statfs(this.mountFor(name));
            const free = stats.bavail * stats.bsize;
            if (!best || free > best.free) {
               best = { name, free };
            }
         } catch {
            this.logger.warn(`Configured cold drive "${name}" is not accessible at ${this.mountFor(name)}; skipping it`);
         }
      }
      return best?.name ?? null;
   }

   private configuredDrives(): string[] {
      return this.config.get("this-service.cold-storage", { infer: true })?.drives ?? [];
   }

   private mountFor(name: string): string {
      return this.mountPattern.replace("$drive_name", name);
   }

   private coldRootFor(name: string): string {
      return path.join(this.mountFor(name), this.coldSubdir);
   }

   /** True if `target` is a path under one of the configured cold drives' cloud-dir roots. */
   private isUnderColdMount(target: string): boolean {
      const resolved = path.resolve(target);
      return this.configuredDrives().some(name => resolved.startsWith(this.coldRootFor(name) + path.sep));
   }

   /** True if the path is a tiered file: a symlink whose target lives on a cold drive. */
   public isColdFile(absPath: string): boolean {
      try {
         const st = fs.lstatSync(absPath);
         if (!st.isSymbolicLink()) return false;
         return this.isUnderColdMount(fs.readlinkSync(absPath));
      } catch {
         return false;
      }
   }

   /**
    * Removes the cold-storage blob(s) backing a path that's about to be deleted, so the
    * cold copy is freed immediately instead of waiting for GC. Call this BEFORE unlinking
    * the path (while the symlink still exists). For a directory it recurses, removing the
    * cold blob of every cold symlink underneath.
    */
   public async removeColdData(absPath: string): Promise<void> {
      let st: fs.Stats;
      try {
         st = await fs.promises.lstat(absPath);
      } catch {
         return; // already gone
      }

      if (st.isSymbolicLink()) {
         try {
            const target = await fs.promises.readlink(absPath);
            if (this.isUnderColdMount(target)) {
               await fs.promises.rm(target, { force: true });
               this.logger.debug(`delete file ${target} (linked to ${absPath}) from cold storage`);
            }
         } catch (e) {
            this.logger.error(`Failed to remove cold data for ${absPath}: ${(e as Error).message}`);
         }
      } else if (st.isDirectory()) {
         let entries: fs.Dirent[];
         try {
            entries = await fs.promises.readdir(absPath, { withFileTypes: true });
         } catch {
            return;
         }
         for (const entry of entries) {
            await this.removeColdData(path.join(absPath, entry.name));
         }
      }
   }

   /* ============================ HOT TIER (Redis) ============================ *
    * The hottest tier: frequently-served files are copied wholesale into Redis and
    * served from there, bypassing the disk entirely. Everything is keyed by absolute
    * path and carries a TTL, so Redis auto-evicts both the cached bytes and the access
    * counters — there is no background cleanup job to run.
    *
    * This lives on the async serving path (FilesService.asStream), not the synchronous
    * FS abstraction, because Redis access is asynchronous.
    * ========================================================================== */

   private hotConfig(): Promise<HotStorageConfig> {
      return this.featureFlag.getPayload(FeatureFlagNamespace.Files, TieredStorageService.HOT_FLAG, HOT_STORAGE_DEFAULT_CONFIG);
   }

   private hotBlobKey(absPath: string): string { return TieredStorageService.HOT_BLOB_PREFIX + absPath; }
   private hotFreqKey(absPath: string): string { return TieredStorageService.HOT_FREQ_PREFIX + absPath; }

   /**
    * If the file is currently cached in Redis (the hot tier), returns a readable stream of
    * its bytes and refreshes the blob TTL (sliding window, so popular files stay hot).
    * Honours an optional byte range ({ start, end }) for video/audio seeking. Returns null
    * if the hot flag is off or the file isn't cached — callers fall back to the disk.
    */
   public async getHotStream(absPath: string, options?: { start?: number; end?: number }): Promise<Readable | null> {
      if (!(await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.HOT_FLAG))) return null;

      const key = this.hotBlobKey(absPath);
      let buf: Buffer | null;
      try {
         buf = await this.redis.getBuffer(key);
      } catch {
         return null;
      }
      if (!buf) return null;

      const cfg = await this.hotConfig();
      void this.redis.expire(key, cfg.ttlSeconds).catch(() => undefined); // sliding TTL
      if (this.metrics) this.metrics.hotStorageHits += 1;

      if (typeof options?.start === "number") {
         const end = typeof options.end === "number" ? options.end : buf.length - 1;
         buf = buf.subarray(options.start, end + 1);
      }
      return Readable.from(buf);
   }

   /** Records a file serve (fire-and-forget): bumps the access counter and promotes to Redis once hot enough. */
   public recordServe(absPath: string): void {
      void this.promoteHotIfFrequent(absPath);
   }

   private async promoteHotIfFrequent(absPath: string): Promise<void> {
      try {
         if (!(await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.HOT_FLAG))) return;

         const cfg = await this.hotConfig();
         const freqKey = this.hotFreqKey(absPath);
         const count = await this.redis.incr(freqKey);
         if (count === 1) await this.redis.expire(freqKey, cfg.frequencyWindowSeconds);
         if (count < cfg.accessThreshold) return;

         const blobKey = this.hotBlobKey(absPath);
         if (await this.redis.exists(blobKey)) return; // already hot

         let size: number;
         try {
            size = (await fs.promises.stat(absPath)).size; // follows a cold symlink to the real bytes
         } catch {
            return; // gone
         }
         if (size > cfg.maxFileBytes) return;

         const bytes = await fs.promises.readFile(absPath);
         await this.redis.set(blobKey, bytes, "EX", cfg.ttlSeconds);
         this.logger.log(`Cached ${absPath} in hot storage (Redis, ${(size / 1e6).toFixed(2)} MB)`);
         if (this.metrics) {
            this.metrics.hotStoragePromotions += 1;
            this.metrics.hotStorageBytesCached += size;
         }
      } catch (e) {
         if (this.metrics) this.metrics.hotStorageErrors += 1;
         this.logger.error(`Hot caching failed for ${absPath}: ${(e as Error).message}`);
      }
   }

   /**
    * Drops a path (and, for a directory, everything beneath it) from the hot tier. Call when
    * a file is deleted, renamed or overwritten so Redis never serves stale/removed bytes.
    */
   public async removeHotData(absPath: string): Promise<void> {
      try {
         await this.redis.del(this.hotBlobKey(absPath), this.hotFreqKey(absPath));
         for (const prefix of [TieredStorageService.HOT_BLOB_PREFIX, TieredStorageService.HOT_FREQ_PREFIX]) {
            const keys = await this.scanHotKeys(`${prefix}${absPath}/*`);
            if (keys.length) await this.redis.del(...keys);
         }
      } catch (e) {
         this.logger.error(`Failed to remove hot data for ${absPath}: ${(e as Error).message}`);
      }
   }

   /** True if the file is currently cached in the hot (Redis) tier. */
   public async isHotFile(absPath: string): Promise<boolean> {
      try {
         return (await this.redis.exists(this.hotBlobKey(absPath))) === 1;
      } catch {
         return false;
      }
   }

   /**
    * Hot-tier totals (number of cached files and their total bytes in Redis). Optionally
    * scoped to files whose absolute path starts with `prefix` (e.g. a single user's dir).
    */
   public async hotStats(prefix?: string): Promise<{ fileCount: number; bytes: number }> {
      const match = prefix ? `${TieredStorageService.HOT_BLOB_PREFIX}${prefix}*` : `${TieredStorageService.HOT_BLOB_PREFIX}*`;
      let fileCount = 0;
      let bytes = 0;
      try {
         const keys = await this.scanHotKeys(match);
         fileCount = keys.length;
         for (const k of keys) {
            try {
               bytes += await this.redis.strlen(k);
            } catch {
               // key vanished (TTL) mid-scan — ignore
            }
         }
      } catch {
         // redis unavailable — report zero
      }
      return { fileCount, bytes };
   }

   private async scanHotKeys(match: string): Promise<string[]> {
      let cursor = "0";
      const keys: string[] = [];
      do {
         const [next, batch] = await this.redis.scan(cursor, "MATCH", match, "COUNT", 200);
         cursor = next;
         keys.push(...batch);
      } while (cursor !== "0");
      return keys;
   }

   /** Recursively counts files under `dir`: total files and how many are in cold storage. */
   public coldStats(dir: string): { total: number; cold: number } {
      let total = 0;
      let cold = 0;
      let entries: fs.Dirent[];
      try {
         entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
         return { total, cold };
      }
      for (const entry of entries) {
         if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
         const full = path.join(dir, entry.name);
         if (entry.isDirectory()) {
            const sub = this.coldStats(full);
            total += sub.total;
            cold += sub.cold;
         } else if (entry.isSymbolicLink()) {
            total++;
            if (this.isColdFile(full)) cold++;
         } else if (entry.isFile()) {
            total++;
         }
      }
      return { total, cold };
   }
}
