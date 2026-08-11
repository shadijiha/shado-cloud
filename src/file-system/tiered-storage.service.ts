import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import path from "path";
import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { EnvVariables } from "src/config/config.validator";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { REDIS_CACHE } from "src/util";
import { MetricsPusherService } from "../metrics-pusher.service";
import { Dirent, State } from "./abstract-file-system.interface";
import { NodeFileSystemService } from "./file-system.service";

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

   // A file is eligible for demotion once it hasn't been accessed for ~1 months.
   private static readonly STALE_AFTER_MS = 1 * 30 * 24 * 60 * 60 * 1000;
   // Don't bother demoting tiny files — the move isn't worth the space reclaimed.
   private static readonly MIN_DEMOTE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

   // Independent feature flags (namespace: Files) for each background behaviour.
   private static readonly DEMOTION_FLAG = "tiered_storage_demotion";
   private static readonly PROMOTION_FLAG = "tiered_storage_promotion";

   private demoting = false;

   // Files currently being promoted (fire-and-forget on access), to dedup concurrent
   // promotions of the same path under a burst of reads.
   private readonly promoting = new Set<string>();

   constructor(
      @Inject() private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly featureFlag: FeatureFlagService,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      @Inject() private readonly fs: NodeFileSystemService,
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


      this.logger.log("Starting tiered-storage demotion sweep (stale files -> cold drive)");

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
               const stat = this.fs.statSync(file); // real file (symlinks are skipped by the walk)
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
      const lst = this.fs.lstatSync(absPath);
      if (!lst || lst.isSymbolicLink()) return;

      const rel = path.relative(cloudDir, absPath);
      const coldPath = path.join(coldRoot, rel);
      // UUID temp name so a leftover temp link (e.g. from a process killed mid-demotion)
      // can never collide and cause EEXIST.
      const tmpLink = `${absPath}.tiering-${randomUUID()}`;

      this.fs.mkdirSync(path.dirname(coldPath), { recursive: true });
      this.fs.copyFileSync(absPath, coldPath); // copyFile works across devices

      try {
         this.fs.symlinkSync(coldPath, tmpLink);
         this.fs.renameSync(tmpLink, absPath); // atomic: replaces the real file with the symlink
      } catch (e) {
         this.fs.rmSync(tmpLink, { force: true });
         this.fs.rmSync(coldPath, { force: true });
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
      let stat: State;
      try {
         stat = await this.fs.lstatSync(path_);
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
      const stat = this.fs.lstatSync(path_);
      if (!stat || !stat.isSymbolicLink()) return null; // not a cold file (anymore)

      const target = this.fs.readlinkSync(path_);
      if (!this.isUnderColdMount(target)) return null;

      const size = this.fs.statSync(target).size; // size of the cold blob
      const tmp = `${path_}.promoting-${process.pid}-${Date.now()}`;

      try {
         this.fs.copyFileSync(target, tmp);   // cold -> main (works across devices)
         this.fs.renameSync(tmp, path_);       // atomic: replace symlink with the real file
      } catch (e) {
         this.fs.rmSync(tmp, { force: true });
         throw e;
      }

      // Real file is now on the main drive; drop the cold blob (GC would also reclaim it).
      this.fs.rmSync(target, { force: true });
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
            const target = path.resolve(await this.fs.readlinkSync(link));
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
            this.fs.rmSync(blob, { force: true });
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
    * Lightweight snapshot for the admin UI: whether tiering is on, per configured cold
    * drive its mount point/cold-file count/total cold bytes, plus overall Redis memory
    * usage (for the "Storage Devices" list). Walks the cold mirror trees on demand.
    */
   public async getOverview(): Promise<{
      flags: { demotion: boolean; promotion: boolean };
      redis: { usedMemory: number; maxMemory: number };
      drives: { name: string; mountPoint: string; coldFileCount: number; coldBytes: number; total: number; free: number; used: number }[];
   }> {
      const flags = {
         demotion: await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.DEMOTION_FLAG),
         promotion: await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, TieredStorageService.PROMOTION_FLAG),
      };

      const redis = await this.redisMemory();

      const drives: { name: string; mountPoint: string; coldFileCount: number; coldBytes: number; total: number; free: number; used: number }[] = [];
      for (const name of this.configuredDrives()) {
         const coldRoot = this.coldRootFor(name);

         let coldFileCount = 0;
         let coldBytes = 0;
         for await (const coldFile of this.walkRealFiles(coldRoot)) {
            try {
               coldBytes += this.fs.statSync(coldFile).size;
               coldFileCount++;
            } catch {
               // file vanished mid-walk — ignore
            }
         }

         // Disk usage of the cold drive (statfs the cold-dir, which lives on that mount).
         let total = 0;
         let free = 0;
         try {
            const st = this.fs.statfsSync(coldRoot);
            total = st.blocks * st.bsize;
            free = st.bavail * st.bsize;
         } catch {
            // mount not present yet — leave usage at 0
         }

         drives.push({ name, mountPoint: this.mountFor(name), coldFileCount, coldBytes, total, free, used: total - free });
      }

      return { flags, redis, drives };
   }

   /** Overall Redis memory usage (bytes used + configured maxmemory; maxMemory 0 = no limit set). */
   public async redisMemory(): Promise<{ usedMemory: number; maxMemory: number }> {
      try {
         const info = await this.redis.info("memory");
         const usedMemory = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0);
         const maxMemory = Number(/(?:^|\n)maxmemory:(\d+)/.exec(info)?.[1] ?? 0);
         return { usedMemory, maxMemory };
      } catch {
         return { usedMemory: 0, maxMemory: 0 };
      }
   }


   /** Recursively yields real (non-symlink, non-hidden) files under `dir`. */
   private async *walkRealFiles(dir: string): AsyncGenerator<string> {
      let entries: Dirent[];
      try {
         entries = this.fs.readdirSync(dir);
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
      let entries: Dirent[];
      try {
         entries = this.fs.readdirSync(dir);
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
            const stats = this.fs.statfsSync(this.mountFor(name));
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
         const st = this.fs.lstatSync(absPath);
         if (!st.isSymbolicLink()) return false;
         return this.isUnderColdMount(this.fs.readlinkSync(absPath));
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
      let st: State;
      try {
         st = this.fs.lstatSync(absPath);
      } catch {
         return; // already gone
      }

      if (st.isSymbolicLink()) {
         try {
            const target = this.fs.readlinkSync(absPath);
            if (this.isUnderColdMount(target)) {
               this.fs.rmSync(target, { force: true });
               this.logger.debug(`delete file ${target} (linked to ${absPath}) from cold storage`);
            }
         } catch (e) {
            this.logger.error(`Failed to remove cold data for ${absPath}: ${(e as Error).message}`);
         }
      } else if (st.isDirectory()) {
         let entries: Dirent[];
         try {
            entries = this.fs.readdirSync(absPath);
         } catch {
            return;
         }
         for (const entry of entries) {
            await this.removeColdData(path.join(absPath, entry.name));
         }
      }
   }

   /** Recursively counts files under `dir`: total files and how many are in cold storage. */
   public coldStats(dir: string): { total: number; cold: number } {
      let total = 0;
      let cold = 0;
      let entries: Dirent[];
      try {
         entries = this.fs.readdirSync(dir);
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
