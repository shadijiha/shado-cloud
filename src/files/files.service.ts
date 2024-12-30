import { HttpException, Inject, Injectable } from "@nestjs/common";
import { AuthService } from "./../auth/auth.service";
import path from "path";
import { UploadedFile } from "./../models/uploadedFile";
import { TempUrl } from "./../models/tempUrl";
import sharp from "sharp";
import ThumbnailGenerator from "fs-thumbnail";
import { REDIS_CACHE, SoftException } from "./../util";
import { FileAccessStat } from "./../models/stats/fileAccessStat";
import { UsedData } from "./../user-profile/user-profile-types";
import { DirectoriesService } from "./../directories/directories.service";
import { LoggerToDb } from "../logging";
import mime from "mime-types";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SearchStat } from "./../models/stats/searchStat";
import { ThumbnailCacheInterceptor } from "./thumbnail-cache.interceptor";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import type Redis from "ioredis";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

type FileServiceResult = Promise<[boolean, string]>;

@Injectable()
export class FilesService {
   public static readonly METADATA_FOLDER_NAME = ".metadata";
   public static readonly THUMBNAILS_FOLDER_NAME = ".thumbnails";
   private readonly dirService: DirectoriesService; // Not injected, because it would cause a circular dependency

   constructor(
      private readonly userService: AuthService,
      @InjectRepository(UploadedFile) private readonly uploadedFileRepo: Repository<UploadedFile>,
      @InjectRepository(SearchStat) searchStateRepo: Repository<SearchStat>,
      @InjectRepository(FileAccessStat) private readonly fileAccessStatRepo: Repository<FileAccessStat>,
      @InjectRepository(TempUrl) private readonly tempUrlRepo: Repository<TempUrl>,
      @Inject() private readonly logger: LoggerToDb,
      @Inject(REDIS_CACHE) private readonly cache: Redis,
      @Inject() private readonly fs: AbstractFileSystem,
      @Inject() private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly featureFlagService: FeatureFlagService,
   ) {
      this.dirService = new DirectoriesService(
         userService,
         this,
         uploadedFileRepo,
         searchStateRepo,
         logger,
         fs,
         config,
      );

      // Sharp cache
      sharp.cache(true);
      sharp.cache({ memory: 1024, items: 5000, files: 500 });
      sharp.simd(true);
   }

   public async asStream(userId: number, relativePath: string, user_agent: string, options?: any) {
      const dir = await this.absolutePath(userId, relativePath);
      if (!this.fs.existsSync(dir)) throw new Error(dir + " does not exist");

      this.updateStats(userId, dir, user_agent);
      const owns = await this.isOwner(userId, dir);

      if (!owns) {
         throw new Error("You don't have permission to access this file " + relativePath);
      }

      return this.fs.createReadStream(dir, options);
   }

   public async upload(userId: number, file: Express.Multer.File, dest: string): FileServiceResult {
      try {
         // Check if user has enough space to upload the file
         const usedData = await this.getUsedData(userId);
         const user = await this.userService.getById(userId);

         if (usedData.total() + file.size > (await user.getMaxData())) {
            return [false, "You don't have enough space to upload this file"];
         }

         const cleanName = path.join(dest, this.replaceIllegalChars(file.originalname));
         const root = await this.getUserRootPath(userId);
         const dir = await this.absolutePath(userId, cleanName);

         const owns = await this.isOwner(userId, dir);
         if (!owns) {
            return [false, "You don't have permission to upload here"];
         }

         const relative = path.relative(root, dir);

         this.fs.writeFileSync(dir, file.buffer);

         let fileDB = await this.uploadedFileRepo.findOne({
            where: { absolute_path: relative, user: { id: userId } },
         });

         // if a file already exists with that name, then most likely we are replacing a file
         // in this case, we'll invalidate old thumbnails
         if (fileDB) {
            await this.invalidateThumbnailsFor(userId, fileDB);
         } else {
            fileDB = new UploadedFile();
            fileDB.absolute_path = relative;
            fileDB.user = await this.userService.getById(userId);
            fileDB.mime = file.mimetype;
            this.uploadedFileRepo.save(fileDB);
         }

         return [true, ""];
      } catch (e) {
         return [false, (e as Error).message];
      }
   }

   public async new(userId: number, name: string): Promise<void> | never {
      const root = await this.getUserRootPath(userId);
      const dir = path.join(root, name);
      const relative = path.relative(root, dir);

      if (!(await this.isOwner(userId, dir))) {
         throw new Error("You don't have permission to create files here");
      }

      this.verifyFileName(dir);

      this.fs.writeFileSync(dir, "");

      // Register file in DB
      const file = new UploadedFile();
      file.user = await this.userService.getById(userId);
      file.absolute_path = relative;
      file.mime = "text/plain";
      this.uploadedFileRepo.save(file);
   }

   public async save(
      userId: number,
      fileRelativePath: string,
      content: string,
      append: boolean | string = false,
   ): FileServiceResult {
      try {
         const dir = await this.absolutePath(userId, fileRelativePath);
         const owns = await this.isOwner(userId, dir);
         if (!owns) {
            return [false, "You don't have permission to save here"];
         }

         if (!append || append == "false") {
            this.fs.writeFileSync(dir, content);
         } else {
            this.fs.appendFileSync(dir, content);
         }

         return [true, ""];
      } catch (e) {
         return [false, (e as Error).message];
      }
   }

   public async delete(userId: number, relativePath: string): FileServiceResult {
      try {
         const root = await this.getUserRootPath(userId);
         const dir = await this.absolutePath(userId, relativePath);

         if (!(await this.isOwner(userId, dir))) {
            return [false, "You don't have permission to delete this file"];
         }

         const relative = path.relative(root, dir);
         this.fs.unlinkSync(dir);

         // See if file is in DB, if yes, then delete it
         const user = await this.userService.getById(userId);
         const uploadedFile = await this.uploadedFileRepo.findOne({
            where: { absolute_path: relative, user: { id: user.id } },
         });
         const accessData = await this.fileAccessStatRepo.find({
            where: { uploaded_file: uploadedFile },
         });
         if (accessData) await this.fileAccessStatRepo.softRemove(accessData);

         // Delete all thumbnails relate to that file
         if (uploadedFile) {
            await this.invalidateThumbnailsFor(userId, uploadedFile);
            await this.uploadedFileRepo.softRemove(uploadedFile);
         }

         return [true, ""];
      } catch (e) {
         return [false, (e as Error).message];
      }
   }

   public async rename(userId: number, name: string, newName: string): Promise<void> | never {
      const root = await this.getUserRootPath(userId);
      const dir = await this.absolutePath(userId, name);
      const newDir = await this.absolutePath(userId, newName);
      const relative = path.relative(root, dir);
      const relativeNew = path.relative(root, newDir);

      if (!(await this.isOwner(userId, dir))) {
         throw new Error("You don't have permission to rename this file");
      }

      this.verifyFileName(newDir);

      this.fs.renameSync(dir, newDir);

      // Rename file in DB
      const file = await this.uploadedFileRepo.findOne({
         where: { absolute_path: relative, user: { id: userId } },
      });

      if (file) {
         this.logger.debug(`[::${this.rename.name}] Renaming file in DB from ${relative} to ${relativeNew}`);
         file.absolute_path = relativeNew;
         this.uploadedFileRepo.save(file);
      } else {
         // Else if it is not in DB then insert it
         this.logger.debug(
            `[::${this.rename.name}] File found found in DB. Inserting it from ${relative} to ${relativeNew}`,
         );

         const mime = FilesService.detectFile(newDir);
         const user = await this.userService.getById(userId);

         const uploadedFile = new UploadedFile();
         uploadedFile.user = user;
         uploadedFile.absolute_path = relativeNew;
         uploadedFile.mime = mime;
         this.uploadedFileRepo.save(uploadedFile);
      }
   }

   public async info(userId: number, relativePath: string) {
      const root = await this.getUserRootPath(userId);
      const dir = await this.absolutePath(userId, relativePath);
      const relative = path.relative(root, dir);

      if (!(await this.isOwner(userId, dir))) {
         throw new Error("You don't have permission to access this file");
      }

      const stats = this.fs.statSync(dir);
      const file = await this.uploadedFileRepo.findOne({
         where: { absolute_path: relative },
      });

      const fileMime = file ? file.mime : FilesService.detectFile(dir);

      // Get temp url if exists and is active
      const tempUrls = await this.tempUrlRepo.find({
         where: { user: { id: userId }, filepath: relative },
      });

      // Get all cached thumbnails for this file
      const thumbails: string[] = [];
      if (file) {
         const thumbnailFolder = path.join(
            await this.createMetaFolderIfNotExists(userId),
            FilesService.THUMBNAILS_FOLDER_NAME,
         );
         const files = this.fs.readdirSync(thumbnailFolder);
         files.forEach((fileEntry) => {
            if (fileEntry.name.startsWith(`${file.id}_`)) {
               thumbails.push(fileEntry.name);
            }
         });
      }

      return {
         extension: path.extname(relativePath),
         mime: fileMime,
         path: path.relative(await this.getUserRootPath(userId), dir),
         name: path.basename(dir),
         is_image: fileMime.includes("image"),
         is_text: fileMime.includes("text") || fileMime == "application/x-empty",
         is_video: fileMime.includes("video"),
         is_audio: fileMime.includes("audio"),
         is_pdf: fileMime.includes("pdf"),
         size: stats.size,
         temp_url: tempUrls.length > 0 ? tempUrls.filter((e) => e.isValid())[0] : null,
         thumbails,
      };
   }

   public async exists(userId: number, relativePath: string) {
      const dir = await this.absolutePath(userId, relativePath);

      if (!(await this.isOwner(userId, dir))) {
         throw new Error("You don't have permission to access this file");
      }

      return this.fs.existsSync(dir);
   }

   public async toThumbnail(
      path_: string,
      userId: number,
      width: number | undefined = undefined,
      height: number | undefined = undefined,
   ) {
      const dir = await this.absolutePath(userId, path_);
      const fileMime = FilesService.detectFile(dir);

      if (!(await this.isOwner(userId, dir))) {
         throw new Error("You don't have permission to access this file");
      }

      if (fileMime.includes("image")) {
         if (!this.fs.existsSync(dir)) throw new Error(dir + " does not exist");

         // Check if thumbnail already exists
         const uploadedFile = await this.uploadedFileRepo.findOne({
            where: { absolute_path: path.normalize(path_), user: { id: userId } },
         });
         const thumbnailFolder = path.join(
            await this.createMetaFolderIfNotExists(userId),
            FilesService.THUMBNAILS_FOLDER_NAME,
         );
         if (
            (await this.featureFlagService.isFeatureFlagDisabled(
               FeatureFlagNamespace.Files,
               "disable_thumbnail_caching_disk",
            )) &&
            uploadedFile
         ) {
            const thumbnailPath = path.join(
               thumbnailFolder,
               `${uploadedFile.id}_${width}x${height}${path.extname(path_)}`,
            );

            if (this.fs.existsSync(thumbnailPath)) {
               this.logger.debug(`[${this.toThumbnail.name}] Found cached thumbnail at ${thumbnailPath}`);
               return this.fs.createReadStream(thumbnailPath);
            }
         }

         const resized = sharp()
            .resize(Number(width) || undefined, Number(height) || undefined)
            .withMetadata();
         const readStream = this.fs.createReadStream(dir).pipe(resized);

         // cache thumbnail for next time and return it
         // Don't do it if we are inside the thumbnail folder (to avoid recursive thumbnail generation)
         if (
            (await this.featureFlagService.isFeatureFlagDisabled(
               FeatureFlagNamespace.Files,
               "disable_thumbnail_caching_disk",
            )) &&
            uploadedFile &&
            !path.normalize(dir).includes(path.normalize(FilesService.THUMBNAILS_FOLDER_NAME))
         ) {
            const thumbnailPath = path.join(
               thumbnailFolder,
               `${uploadedFile.id}_${width}x${height}${path.extname(path_)}`,
            );
            await readStream.toFile(thumbnailPath);

            this.logger.debug(`[${this.toThumbnail.name}] Created cached thumbnail at ${thumbnailPath}`);
            return this.fs.createReadStream(thumbnailPath);
         }

         if (!uploadedFile)
            this.logger.debug(
               `[${this.toThumbnail.name}] Unable to cache thumbnail for ${path_} because it is not indexed`,
            );

         this.logger.debug(`[${this.toThumbnail.name}] Returning computed resized thumbnail for ${path_}`);

         return readStream;
      } else if (fileMime.includes("video")) {
         // If it is a video generate thumbnail
         const thumbnailPath = path.join(path.dirname(dir), ".videometa." + path.basename(dir) + ".png");

         this.logger.debug(`[${this.toThumbnail.name}] Generating thumbnail for video at ${path_}`);

         // TOOD: CHange this library because it is hard to test
         // instead of returning errors it prints them to the console
         const thumbGen = new ThumbnailGenerator({
            verbose: false, // Whether to print out warning/errors
            size: [width ?? "?", height ?? "?"], // Default size, either a single number of an array of two numbers - [width, height].
            quality: 70, // Default quality, between 1 and 100
         });

         await thumbGen.getThumbnail({
            path: dir,
            output: thumbnailPath,
         });

         // Delete that thumbnail after 1 second (request sent)
         // TODO make this a job instead
         setTimeout(() => {
            this.fs.unlinkSync(thumbnailPath);
         }, 1000);

         return this.fs.createReadStream(thumbnailPath);
      }
      return null;
   }

   public async getUserRootPath(userId: number): Promise<string> {
      // Get user
      const user = await this.userService.getById(userId);
      if (!user) {
         throw new HttpException(
            {
               errors: [{ field: "", message: "Invalid user Id" }],
            },
            400,
         );
      }

      return path.join(this.config.get("CLOUD_DIR"), user.email);
   }

   public async absolutePath(userId: number, relativePath: string) {
      return path.join(await this.getUserRootPath(userId), relativePath);
   }

   public static detectFile(filename: string): string {
      const result = mime.lookup(filename);
      // if mime doesn't regonize it, then we'll try to guess it
      if (result == false) {
         if (filename.includes("jpg") || filename.includes("jpeg")) return "image/jpeg";
         if (filename.includes("png")) return "image/png";
      }
      return result == false ? "" : result;
   }

   public verifyFileName(fullpath: string) {
      // Verify that the user is not creating a hidden folder
      const basename = path.basename(fullpath);
      if (basename.startsWith(".")) throw new SoftException("Directory/File name cannot start with '.'");

      // Check for illegal chars
      const illegal = ["?", "!", "[", "]", "{", "}", "/", "\\", "*", "<", ">", "|", '"', "'", ":", "@"];
      for (const c of illegal) {
         if (basename.includes(c)) throw new SoftException("Directory/File name cannot contain " + c);
      }
   }

   public replaceIllegalChars(filename: string) {
      // Verify that the user is not creating a hidden folder
      let basename = path.basename(filename);
      while (basename.startsWith(".")) {
         basename = basename.substring(1);
      }

      // Check for illegal chars
      const illegal = ["?", "!", "[", "]", "{", "}", "/", "\\", "*", "<", ">", "|", '"', "'", "@", ":"];
      for (const c of illegal) {
         basename = basename.replace(new RegExp(`\\${c}`, "g"), "");
      }

      // Check if the name is empty after replacing stuff
      if (basename == "") basename = new Date().toLocaleDateString().replace(":", "-");

      return basename;
   }

   public async profilePictureInfo(userId: number) {
      const dir = await this.absolutePath(userId, FilesService.METADATA_FOLDER_NAME + "/prof");
      return {
         exists: this.fs.existsSync(dir),
         path: path.relative(await this.getUserRootPath(userId), dir),
      };
   }

   public async getUsedData(userId: number) {
      // TODO: Cache this in redis
      const root = await this.getUserRootPath(userId);
      const user = await this.userService.getById(userId);
      const used_data: UsedData = new UsedData();
      used_data.max = user.getMaxData();

      const arrayOfFiles = await this.dirService.listrecursive(userId);
      arrayOfFiles.forEach((relativePath) => {
         const filePath = path.join(root, relativePath);
         // Get the file extension
         const ext = path.extname(filePath).toLowerCase();
         const size = this.fs.statSync(filePath).size;

         if (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif") used_data.images += size;
         else if (ext == ".mp4" || ext == ".webm" || ext == ".mkv" || ext == ".avi" || ext == ".mov" || ext == ".wmv") {
            used_data.videos += size;
         } else if (
            ext == ".pdf" ||
            ext == ".doc" ||
            ext == ".docx" ||
            ext == ".xls" ||
            ext == ".xlsx" ||
            ext == ".ppt" ||
            ext == ".pptx" ||
            ext == ".odt" ||
            ext == ".ods" ||
            ext == ".odp" ||
            ext == ".txt" ||
            ext == ".rtf"
         ) {
            used_data.documents += size;
         } else used_data.other += size;
      });

      return used_data;
   }

   public async createMetaFolderIfNotExists(userId: number): Promise<string> {
      const dir = await this.absolutePath(userId, FilesService.METADATA_FOLDER_NAME);
      if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });

      // Create thumbails folder
      if (!this.fs.existsSync(path.join(dir, FilesService.THUMBNAILS_FOLDER_NAME))) {
         this.fs.mkdirSync(path.join(dir, FilesService.THUMBNAILS_FOLDER_NAME), { recursive: true });
      }

      return dir;
   }

   private async updateStats(userId: number, absolute_path: string, user_agent: string) {
      const root = await this.getUserRootPath(userId);
      const sanitizedRelative = path.relative(root, absolute_path); // Need this to avoid weird slashes
      const user = await this.userService.getById(userId);

      // Check if file is indexed
      let indexed = await this.uploadedFileRepo.findOne({
         where: { absolute_path: sanitizedRelative, user: { id: userId } },
      });

      // If not index then created it
      if (!indexed) {
         indexed = new UploadedFile();
         indexed.absolute_path = sanitizedRelative;
         indexed.user = user;
         indexed.mime = FilesService.detectFile(absolute_path);
         await this.uploadedFileRepo.save(indexed);
      }

      // Now see if the stat already exists
      let stat = await this.fileAccessStatRepo.findOne({
         where: { user: { id: userId }, uploaded_file: indexed, user_agent },
      });
      if (!stat) {
         stat = new FileAccessStat();
         stat.uploaded_file = indexed;
         stat.user = user;
         stat.count = 0;
         stat.user_agent = user_agent;
         await this.fileAccessStatRepo.save(stat);
      }

      stat.count += 1;
      await this.fileAccessStatRepo.save(stat);
   }

   public async isOwner(userId: number, absolute_path: string) {
      const root = await this.getUserRootPath(userId);
      const sanitizedRelative = path.relative(absolute_path, root);
      // If we replace all "..\" and there is still and email in the path,
      // then the user is trying to access a file outside of his root
      const res = sanitizedRelative.replace(/\.\./g, "").replace(/\\/g, "").replace(/\//g, "");

      const cond = res.length == 0;
      if (!cond) {
         this.logger.log(`Not owner of ${absolute_path}. Sanatized result: ${res}. Sanatized length: ${res.length}`);
      }
      return cond;
   }

   private async invalidateThumbnailsFor(userId: number, uploadedFile: UploadedFile): Promise<void> {
      const thumbnailFolder = path.join(
         await this.createMetaFolderIfNotExists(userId),
         FilesService.THUMBNAILS_FOLDER_NAME,
      );
      const files = this.fs.readdirSync(thumbnailFolder);
      files.forEach((fileEntry) => {
         if (fileEntry.name.startsWith(`${uploadedFile.id}_`)) {
            this.fs.unlinkSync(path.join(thumbnailFolder, fileEntry.name));
         }
      });

      // Invalidate cache
      const cacheKey = ThumbnailCacheInterceptor.getCacheKey(userId, uploadedFile.absolute_path, 0, 0, false);
      const pattern = `${cacheKey}*`;

      let cursor = "0";
      do {
         // SCAN command to get keys matching the pattern
         const [newCursor, keys] = await this.cache.scan(cursor, "MATCH", pattern);
         cursor = newCursor;

         if (keys.length > 0) {
            await this.cache.del(...keys); // Delete matching keys
            this.logger.debug(`Deleted keys: ${keys.join(", ")}`);
         }
      } while (cursor !== "0");
   }
}
