import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { NodeFileSystemService } from "./file-system.service";
import * as fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Repository } from "typeorm";
import { Readable } from "stream";
import { PathLike } from "src/file-system/abstract-file-system.interface";
import { DynamicFileEntity } from "src/models/dynamicFile";
import { MetricsPusherService } from "../metrics-pusher.service";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { EnvVariables } from "src/config/config.validator";

type DriveInfo = {
    name: string,
    model: string,
    sizeGB: number,
    isNVMe: boolean,
    isSSD: boolean,
    isHDD: boolean,
    type: 'NVMe' | 'SSD' | 'HDD'
}

/**
 * This file system fetches files from main NVMe or cold storage (additional drives)
 */
@Injectable()
export class DynamicFileSystemService extends NodeFileSystemService implements OnModuleInit {

    private readonly mainDriveName = "/dev/nvme0n1p2";
    //private additionalDrives: DriveInfo[] = [];
    private readonly additionalDrivesMountPattern = "/mnt/$drive_name";

    private readonly logger = new Logger(DynamicFileSystemService.name);

    // A file is eligible for demotion once it has not been accessed for this long (~6 months).
    private static readonly STALE_AFTER_MS = 10 * 1000;// 10 sec for dev //6 * 30 * 24 * 60 * 60 * 1000;
    // Don't bother demoting tiny files — the move overhead isn't worth the space saved.
    private static readonly MIN_DEMOTE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

    constructor(
        @InjectRepository(DynamicFileEntity) private readonly dynFilesRepo: Repository<DynamicFileEntity>,
        @Inject() private readonly config: ConfigService<EnvVariables>,
        @Inject() private readonly featureFlag: FeatureFlagService,
        @Optional() @Inject(MetricsPusherService) private readonly metrics?: MetricsPusherService,
    ) {
        super();
    }

    onModuleInit() {
        // this.additionalDrives = [...this.getDrives()
        //     .filter(d => d.sizeGB > 100)
        //     .filter(d => d.name !== this.mainDriveName)];
    }

    public async readdir(
        _path: PathLike,
        options?: {
            encoding?: BufferEncoding | null | undefined;
        },
    ) {
        // Read files in non cold then append cold files that belong to that dir
        let result = await super.readdir(_path, { ...options });

        const coldFiles = await this.findDynamicFilesInDirQuery(_path.toString()).getMany();
        if (coldFiles.length > 0) {
            result = [...result,
            ...coldFiles.map(f => ({
                name: path.basename(f.path),
                isDirectory: () => false,
                isFile: () => true,
                isBlockDevice: () => false,
                isCharacterDevice: () => false,
                isSymbolicLink: () => false,
                isFIFO: () => false,
                isSocket: () => false,
            }))]
        }

        return result;
    }

    public async stat(path: string) {
        return super.stat(await this.getPath(path));
    }

    public async createReadStream(path: PathLike, options?: BufferEncoding): Promise<Readable> {
        const filePath = path.toString();
        const cold = await this.isInColdStorage(filePath);
        this.recordAccess(cold);
        if (cold) {
            // Reading a cold file promotes it back to the main drive
            await this.moveBackToMainDrive(await this.dynFilesRepo.findOne({ where: { path: filePath } }));
        }

        return super.createReadStream(filePath, options);
    }

    public async rmdir(path: string, options: { recursive: boolean }): Promise<void> {
        await super.rmdir(path, options);

        // Check if that dir has files that were moved to cold storage
        const coldToDelete = await this.findDynamicFilesInDirQuery(path).getMany();

        for (const file of coldToDelete) {
            await super.unlink(this.getColdStoragePath(file));
        }

        await this.dynFilesRepo.remove(coldToDelete);
    }

    public async exists(path: string): Promise<boolean> {
        // Check in main drive first
        if (await super.exists(path)) return true;

        // Otherwise need to fetch it from cold drives
        const dyn = await this.dynFilesRepo.findOne({ where: { path } });
        if (!dyn) return false;

        return await super.exists(this.getColdStoragePath(dyn));
    }

    public async appendFile(path: string, content: string): Promise<void> {
        if (!(await this.isInColdStorage(path))) {
            return super.appendFile(path, content);
        }

        // if user modifies a file in cold storage, it needs to be moved to main drive
        const dyn = await this.dynFilesRepo.findOne({ where: { path } });
        await this.moveBackToMainDrive(dyn);
        return super.appendFile(path, content);
    }

    public async unlink(path: string) {
        await super.unlink(await this.getPath(path));

        // Drop the cold-storage index entry if one exists
        const dyn = await this.dynFilesRepo.findOne({ where: { path } });
        if (dyn) {
            await this.dynFilesRepo.remove(dyn);
        }
    }

    public async rename(oldPath: string, newPath: string) {
        if (!(await this.isInColdStorage(oldPath))) {
            return super.rename(oldPath, newPath);
        }

        // if user renames a file in cold storage, it needs to be moved to main drive

        // move back to main drive
        const dyn = await this.dynFilesRepo.findOne({ where: { path: oldPath } });
        await this.moveBackToMainDrive(dyn);
        await super.rename(oldPath, newPath);
    }

    public async readFile(path: string, encoding: BufferEncoding): Promise<string | Buffer> {
        const cold = await this.isInColdStorage(path);
        this.recordAccess(cold);
        if (cold) {
            // Reading a cold file promotes it back to the main drive
            await this.moveBackToMainDrive(await this.dynFilesRepo.findOne({ where: { path } }));
        }

        return super.readFile(path, encoding);
    }

    /****** Helpers *******/
    private async moveBackToMainDrive(file: DynamicFileEntity) {
        if (!file) {
            return;
        }

        const coldPath = this.getColdStoragePath(file);
        if (!(await super.exists(coldPath))) {
            return;
        }

        await this.moveAcrossDrives(coldPath, file.path);
        await this.dynFilesRepo.remove(file);

        // A file was physically moved from a cold drive back to the main drive.
        if (this.metrics) this.metrics.coldStoragePromotions++;
    }

    /**
     * Moves a file between drives. `rename()` only works within a single filesystem;
     * the main drive and a cold drive are different physical devices, so a plain rename
     * throws EXDEV. In that case we fall back to a copy + delete.
     */
    private async moveAcrossDrives(from: string, to: string) {
        try {
            await super.rename(from, to);
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== "EXDEV") {
                throw e;
            }
            // Cross-device move: copy then remove the source.
            await fs.promises.copyFile(from, to);
            await fs.promises.unlink(from);
        }
    }

    /** Record whether a file read was served from cold storage (true) or the main drive (false). */
    private recordAccess(cold: boolean) {
        if (!this.metrics) return;
        if (cold) this.metrics.coldStorageAccesses++;
        else this.metrics.hotStorageAccesses++;
    }

    /** Periodically publish the number of files currently parked on cold drives as a gauge. */
    @Cron(CronExpression.EVERY_MINUTE)
    public async updateColdStorageGauge() {
        if (!this.metrics) return;
        this.metrics.coldStorageFileCount = await this.dynFilesRepo.count();
    }

    /**
     * Daily sweep that demotes files which haven't been accessed in ~6 months to a cold
     * drive. Uses the filesystem access time (atime) as the "last accessed" signal.
     *
     * Guarded by the `dynamic_file_system` flag: if the dynamic backend isn't active, the
     * plain Node filesystem would be unable to read anything we move to a cold drive, so
     * demoting would make those files disappear.
     */
    //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    @Cron(CronExpression.EVERY_MINUTE)
    public async demoteStaleFiles(): Promise<void> {
        if (!(await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Files, "dynamic_file_system"))) {
            return;
        }

        this.logger.log("Running cold storage demoter cron job");

        const cloudDir = this.config.get("this-service.cloud-dir", { infer: true });
        if (!cloudDir) {
            this.logger.warn("Cold-storage demotion skipped: cloud-dir is not configured");
            return;
        }

        const drive = await this.pickColdDrive();
        if (!drive) {
            this.logger.warn("Cold-storage demotion skipped: no writable cold drive found under /mnt");
            return;
        }

        const cutoff = Date.now() - DynamicFileSystemService.STALE_AFTER_MS;
        const start = performance.now();
        let demoted = 0;
        let bytesMoved = 0;
        let errors = 0;

        for await (const filePath of this.walkMainDriveFiles(cloudDir)) {
            try {
                const stat = await super.stat(filePath);
                if (stat.atime.getTime() > cutoff) continue;                          // accessed recently
                if (stat.size < DynamicFileSystemService.MIN_DEMOTE_SIZE_BYTES) continue; // too small to bother

                await this.demoteFile(filePath, drive);
                demoted++;
                bytesMoved += stat.size;
            } catch (e) {
                errors++;
                this.logger.error(`Failed to demote ${filePath}: ${(e as Error).message}`);
            }
        }

        const elapsed = Math.round(performance.now() - start);
        this.logger.log(
            `Cold-storage sweep complete: demoted ${demoted} file(s), ` +
            `${(bytesMoved / 1e6).toFixed(2)} MB moved to "${drive}", ${errors} error(s), ${elapsed}ms`,
        );

        if (this.metrics) {
            this.metrics.coldStorageDemotions += demoted;
            this.metrics.coldStorageBytesMoved += bytesMoved;
            this.metrics.coldStorageDemotionErrors += errors;
            this.metrics.coldStorageLastSweepMs = elapsed;
        }
    }

    /** Recursively yields every regular file on the main drive under `dir` (skips hidden/system entries). */
    private async *walkMainDriveFiles(dir: string): AsyncGenerator<string> {
        let entries: Awaited<ReturnType<NodeFileSystemService["readdir"]>>;
        try {
            entries = await this.readMainDriveDir(dir);
        } catch {
            return; // unreadable directory — skip
        }

        for (const entry of entries) {
            // Skip hidden files and internal folders (e.g. .meta thumbnails, _system).
            if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                yield* this.walkMainDriveFiles(full);
            } else if (entry.isFile()) {
                yield full;
            }
        }
    }

    /**
     * Lists a directory on the main drive only (bypasses the cold-file merge done by
     * this.readdir). Kept separate so the `super` call stays out of the async generator
     * above — `super` inside an async generator breaks TypeScript's emit.
     */
    private async readMainDriveDir(dir: string) {
        return super.readdir(dir);
    }

    /** Moves a single file from the main drive to the given cold drive and indexes it. */
    private async demoteFile(absPath: string, driveName: string) {
        const entity = new DynamicFileEntity();
        entity.id = randomUUID();
        entity.path = absPath;
        entity.driveName = driveName;

        const coldPath = this.getColdStoragePath(entity);
        await super.mkdir(path.dirname(coldPath), { recursive: true });
        await this.moveAcrossDrives(absPath, coldPath);

        try {
            await this.dynFilesRepo.save(entity);
        } catch (e) {
            // Roll the move back so the file stays reachable on the main drive.
            await this.moveAcrossDrives(coldPath, absPath).catch(() => undefined);
            throw e;
        }
    }

    /**
     * Picks the configured cold drive (this-service.cold-storage.drives) with the most
     * free space. Each name maps to a mount at /mnt/<name>. Returns null if none are
     * configured or reachable.
     */
    private async pickColdDrive(): Promise<string | null> {
        const configured = this.config.get("this-service.cold-storage", { infer: true })?.drives ?? [];
        if (configured.length === 0) {
            this.logger.warn("No cold-storage drives configured (this-service.cold-storage.drives); skipping demotion");
            return null;
        }

        let best: { name: string; free: number } | null = null;
        for (const name of configured) {
            const mountPath = this.additionalDrivesMountPattern.replace("$drive_name", name);
            try {
                const stats = await fs.promises.statfs(mountPath);
                const free = stats.bavail * stats.bsize;
                if (!best || free > best.free) {
                    best = { name, free };
                }
            } catch {
                this.logger.warn(`Configured cold drive "${name}" is not accessible at ${mountPath}; skipping it`);
            }
        }

        return best?.name ?? null;
    }

    /**
     * Moves every file currently in cold storage back to the main drive and clears the
     * index. Call this before turning the dynamic filesystem off, otherwise the plain
     * Node filesystem (which knows nothing about cold drives) can no longer see those
     * files. Safe to call repeatedly; a no-op when nothing is parked on cold drives.
     */
    public async drainColdStorage(): Promise<{ moved: number; errors: number }> {
        const all = await this.dynFilesRepo.find();
        if (all.length === 0) {
            return { moved: 0, errors: 0 };
        }

        this.logger.log(`Repatriating ${all.length} cold-storage file(s) back to the main drive...`);
        let moved = 0;
        let errors = 0;

        for (const file of all) {
            try {
                if (await super.exists(this.getColdStoragePath(file))) {
                    await this.moveBackToMainDrive(file); // moves cold -> main, removes the row, bumps the promotion metric
                    moved++;
                } else {
                    // The cold copy is already gone — drop the dangling index row so the
                    // file isn't reported as existing once we're back on the plain FS.
                    await this.dynFilesRepo.remove(file);
                    this.logger.warn(`Cold file missing on disk while draining: ${file.path} (index row removed)`);
                    errors++;
                }
            } catch (e) {
                errors++;
                this.logger.error(`Failed to repatriate cold file ${file.path}: ${(e as Error).message}`);
            }
        }

        this.logger.log(`Cold storage drained: ${moved} file(s) restored to the main drive, ${errors} error(s)`);
        return { moved, errors };
    }

    /**
     * Reconciles the cold-storage index against what's actually on disk. Protects against
     * drift caused by direct DB edits while the app was off, or crashes mid-move. For each
     * indexed row:
     *   - on main + cold  -> conflict; main wins, drop the (now-redundant) index row
     *   - on main only    -> stale row (file isn't really cold); drop it
     *   - on neither       -> dangling row; drop it
     *   - on cold only     -> valid; keep it
     * Only ever removes *index rows*, never files. Returns the number of rows pruned.
     *
     * NOTE: a cold file whose row was deleted directly cannot be recovered here — its
     * path mapping is gone — so such orphans are detected separately, not by this pass.
     */
    public async reconcileIndex(): Promise<{ pruned: number }> {
        const rows = await this.dynFilesRepo.find();
        let pruned = 0;

        for (const row of rows) {
            const onMain = await super.exists(row.path);
            const onCold = await super.exists(this.getColdStoragePath(row));

            if (!onMain && onCold) {
                continue; // normal, valid cold file
            }

            if (onMain && onCold) {
                this.logger.warn(
                    `Reconcile: "${row.path}" exists on both main and cold drives; ` +
                    `treating main as source of truth and dropping the index row ` +
                    `(cold copy at ${this.getColdStoragePath(row)} is now orphaned)`,
                );
            } else if (onMain) {
                this.logger.warn(`Reconcile: "${row.path}" is on the main drive but indexed as cold; dropping stale row`);
            } else {
                this.logger.warn(`Reconcile: "${row.path}" is missing from both drives; dropping dangling row`);
            }

            await this.dynFilesRepo.remove(row);
            pruned++;
        }

        if (pruned > 0) {
            this.logger.warn(`Cold-storage index reconciled: pruned ${pruned} inconsistent row(s)`);
            if (this.metrics) this.metrics.coldStorageIndexPruned += pruned;
        }

        return { pruned };
    }

    private getDrives(): DriveInfo[] {
        const blockDir = '/sys/block';
        const devices = fs.readdirSync(blockDir)
            .filter(name => !name.startsWith('loop') && !name.startsWith('ram'));

        return devices.map(name => {
            const devPath = path.join(blockDir, name);
            const read = (file) => {
                try { return fs.readFileSync(path.join(devPath, file), 'utf-8').trim(); }
                catch { return null; }
            };

            const rotational = read('queue/rotational');
            const size = parseInt(read('size') || '0') * 512; // sectors to bytes
            const model = read('device/model');

            return {
                name: `/dev/${name}`,
                model,
                sizeGB: (size / 1e9),
                isNVMe: name.startsWith('nvme'),
                isSSD: rotational === '0',
                isHDD: rotational === '1',
                type: name.startsWith('nvme') ? 'NVMe' : (rotational === '0' ? 'SSD' : 'HDD')
            };
        });
    }

    private async getPath(path: string) {
        if (await super.exists(path)) {
            return path;
        }

        const dyn = await this.dynFilesRepo.findOne({ where: { path } });
        return dyn ? this.getColdStoragePath(dyn) : path;
    }

    private async isInColdStorage(path: string): Promise<boolean> {
        // A file is in cold storage when it is no longer present on the main drive
        return !(await super.exists(path));
    }

    private getColdStoragePath(file: DynamicFileEntity) {
        const coldDrivePath = this.additionalDrivesMountPattern.replace("$drive_name", file.driveName);
        return `${coldDrivePath}/cloud-dir/${file.id}`;
    }

    private findDynamicFilesInDirQuery(dir: string) {
        const normalizedDir = path.normalize(path.normalize(dir) + path.sep);

        return this.dynFilesRepo.createQueryBuilder('file')
            .where('file.path LIKE :prefix', { prefix: `${normalizedDir}%` });
    }
}
