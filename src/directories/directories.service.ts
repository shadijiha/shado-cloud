import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { AuthService } from "./../auth/auth.service";
import { FilesService } from "./../files/files.service";
import { type DirectoryInfo } from "./directoriesApiTypes";
import { type FileInfo } from "./../files/filesApiTypes";
import path from "path";
import { type User } from "./../models/user";
import archiver from "archiver";
import extract from "extract-zip";
import { AppLogger } from "./../logging";
import { UploadedFile } from "./../models/uploadedFile";
import { In, Like, Repository } from "typeorm";
import { SearchStat } from "./../models/stats/searchStat";
import { InjectRepository } from "@nestjs/typeorm";
import { AbstractFileSystem, Dirent, State } from "src/file-system/abstract-file-system.interface";
import { TieredStorageService } from "src/file-system/tiered-storage.service";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";

@Injectable()
export class DirectoriesService {
   constructor(
      private readonly userService: AuthService,
      @Inject(forwardRef(() => FilesService)) private readonly fileService: FilesService,
      @InjectRepository(UploadedFile) private readonly uploadedFileRepo: Repository<UploadedFile>,
      @InjectRepository(SearchStat) private readonly searchStatRepo: Repository<SearchStat>,
      @Inject() private readonly logger: AppLogger,
      @Inject() private readonly fs: AbstractFileSystem,
      @Inject() private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly tieredStorage: TieredStorageService,
   ) {}

   public async root(userId: number) {
      return await this.fileService.getUserRootPath(userId);
   }

   public async list(
      userId: number,
      relativePath: string,
      fetch_related_keys_in_redis = false,
      fetch_db_records = false,
      pagination?: {page: number, limit: number},
      sortBy?: [string, string][]
   ) {
      const dir = await this.fileService.absolutePath(userId, relativePath);

      if (!(await this.fileService.isOwner(userId, dir))) {
         throw new Error("You do not have access to this directory");
      }

      const dirListUnsorted = this.fs.readdirSync(dir);
      
      // Sort first before pagination, so that the user gets a consistent view of the directory across pages.
      const sortCol = sortBy?.[0]?.[0];
      const sortDir = (sortBy?.[0]?.[1] || "ASC")?.toUpperCase();

      const fsStatsCache: Record<string, State> = {};
      let dirList = dirListUnsorted;
      
      if (sortCol) {
         dirList = dirListUnsorted.sort((a: Dirent, b: Dirent) => {
            // Directories always first
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;

            if (sortCol === "lastModified") {
               // Get file stats for both files to compare last modified times
               const aPath = path.join(dir, a.name);
               const bPath = path.join(dir, b.name);

               const aStats = fsStatsCache[aPath] || (fsStatsCache[aPath] = this.fs.statSync(aPath));
               const bStats = fsStatsCache[bPath] || (fsStatsCache[bPath] = this.fs.statSync(bPath));

               const diff = aStats.mtime.getTime() - bStats.mtime.getTime();
               return sortDir === "DESC" ? -diff : diff;
            }
            // Default: name
            const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            return sortDir === "DESC" ? -cmp : cmp;
         });
      }

      // Pagination at service level. Always produce metadata (defaulting to page 1,
      // limit 50 — matching the documented API defaults) so the controller can safely
      // build its `meta` block. Previously, calling /directory/list without page/limit
      // left paginationMetadata undefined and crashed the controller with
      // "Cannot read properties of undefined (reading 'limit')".
      const page = Math.max(1, pagination?.page || 1);
      const limit = Math.min(200, Math.max(1, pagination?.limit || 50));
      const total = dirList.length;
      const totalPages = Math.ceil(total / limit);
      const start = (page - 1) * limit;

      const paginationMetadata: { page: number, limit: number, total: number, totalPages: number, start: number } =
         { page, limit, total, totalPages, start };

      const files = dirList.slice(start, start + limit);

      const result: Array<DirectoryInfo | FileInfo> = [];
      for (const file of files) {
         try {
            if (file.isDirectory()) {
               const userRoot = await this.fileService.getUserRootPath(userId);
               const fullPath = path.join(dir, file.name);
               const stats = fsStatsCache[fullPath] || this.fs.statSync(fullPath);
               result.push({
                  name: file.name,
                  path: path.relative(userRoot, dir),
                  is_dir: true,
                  lastModified: stats.mtime.toISOString(),
               });
            } else {
               result.push(await this.fileService.info(userId, path.join(relativePath, file.name), fetch_related_keys_in_redis ?? false, fetch_db_records ?? false));
            }
         } catch (e) {
            // Don't let one unreadable entry (e.g. a dangling symlink from a cold drive
            // that's missing/unmounted) abort the whole directory listing.
            this.logger.error(`Skipping unreadable entry "${file.name}" in ${dir}: ${(e as Error).message}`);
         }
      }

      return {
         paginatedItems: result,
         paginationMetadata,
      }
   }

   public async new(userId: number, name: string) {
      const dir = await this.fileService.absolutePath(userId, name);

      if (!(await this.fileService.isOwner(userId, dir))) {
         throw new Error("You do not have access to this directory");
      }

      this.fileService.verifyFileName(dir);

      this.fs.mkdirSync(dir, { recursive: true });
   }

   public async delete(userId: number, relativePath: string) {
      const root = await this.fileService.absolutePath(userId, "");
      const dir = path.join(root, relativePath);

      if (!(await this.fileService.isOwner(userId, dir))) {
         throw new Error("You do not have permission to delete this directory");
      }

      // Get all files in that dir recusively, and for each
      // delete the index from DB
      for (const file of await this.getAllFiles(dir)) {
         const relative = path.relative(root, file.path);
         try {
            await this.uploadedFileRepo.softRemove({
               absolute_path: relative,
               user: { id: userId },
            });
         } catch (e) {
            this.logger.logException(new Error("Unable to delete file " + relative + ". " + (e as Error).message));
         }
      }

      // Free any cold blobs backing symlinks under this directory before removing it.
      await this.tieredStorage.removeColdData(dir);
      this.fs.rmdirSync(dir, { recursive: true });
   }

   public async rename(userId: number, name: string, newName: string) {
      const dir = await this.fileService.absolutePath(userId, name);
      const newDir = await this.fileService.absolutePath(userId, newName);

      if (!(await this.fileService.isOwner(userId, dir)) || !(await this.fileService.isOwner(userId, newDir))) {
         throw new Error("You do not have permission to rename this directory");
      }

      this.fileService.verifyFileName(newDir);
      this.fs.renameSync(dir, newDir);
   }

   public async createNewUserDir(user: User) {
      const email = await this.userService.getEmail(user.id);
      if (!email) return;
      const dir = path.join(this.config.get("this-service.cloud-dir", { infer: true }), email);
      if (!this.fs.existsSync(dir)) {
         this.fs.mkdirSync(dir);
      }
   }

   public async listrecursive(userId: number, showHidden = false) {
      const dir = await this.fileService.getUserRootPath(userId);
      const files = await this.getAllFiles(dir);

      return files
         .map((filedata) => {
            return path.relative(dir, filedata.path);
         })
         .filter((file) => {
            if (!showHidden && file.startsWith(".")) return false;
            return true;
         })
         .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
   }

   public async search(userId: number, searchText: string) {
      const files = await this.uploadedFileRepo.find({
         where: [{ absolute_path: Like(`%${searchText}%`), user: { id: userId } }],
      });

      // Save stats
      const stat = new SearchStat();
      stat.text = searchText;
      stat.user = await this.userService.getById(userId);
      await this.searchStatRepo.save(stat);

      return files ?? [];
   }

   public async zip(userId: number, name: string) {
      const dir = await this.fileService.absolutePath(userId, name);

      if (!(await this.fileService.isOwner(userId, dir))) {
         throw new Error("You do not have permission to zip this directory");
      }

      if (!(this.fs.lstatSync(dir)).isDirectory()) {
         throw new Error("FIle to zip must be a directory");
      }

      const output = this.fs.createWriteStream(dir + ".zip");
      const archive = archiver("zip");

      archive.on("error", (err) => {
         this.logger.logException(err);
      });
      archive.pipe(output);
      archive.directory(dir, false);
      void archive.finalize();
   }

   public async unzip(userId: number, name: string) {
      const dir = await this.fileService.absolutePath(userId, name);
      const fileFullName = path.basename(dir);
      const fileName = path.parse(fileFullName).name;
      const dirPath = path.dirname(dir);
      const outputPath = path.join(dirPath, fileName);

      if (!(await this.fileService.isOwner(userId, dir))) {
         throw new Error("You do not have permission to unzip this directory");
      }

      await extract(dir, { dir: outputPath });

      // After extracting the zip, go though all the files and index them
      const files = await this.getAllFiles(outputPath);
      const absoluteRootPath = await this.fileService.absolutePath(userId, "");
      const user = await this.userService.getById(userId);

      for (const file of files) {
         const relativePath = path.relative(absoluteRootPath, file.path);
         const indexed = new UploadedFile();
         indexed.user = user;
         indexed.absolute_path = relativePath;
         indexed.mime = FilesService.detectFile(file.path);
         await this.uploadedFileRepo.save(indexed);
      }
   }

   public parent(_path: string) {
      if (_path) {
         return path.join(_path, "..");
      } else {
         return "";
      }
   }

   private async getAllFiles(path: string) {
      const entries = this.fs.readdirSync(path);

      // Get files within the current directory and add a path key to the file objects
      const files = entries
         .filter((file) => !file.isDirectory())
         .map((file) => ({ ...file, path: path + "/" + file.name }));

      // Get folders within the current directory
      const folders = entries.filter((folder) => folder.isDirectory());

      /*
              Add the found files within the subdirectory to the files array by calling the
              current function itself
            */

      for (const folder of folders) {
         files.push(...await this.getAllFiles(`${path}/${folder.name}/`));
      }

      return files;
   }
}
