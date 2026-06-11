import { Inject, Injectable, Logger } from "@nestjs/common";
import path from "path";
import { AuthService } from "../auth/auth.service";
import { FilesService } from "../files/files.service";
import { LoggerToDb } from "../logging";
import { User } from "../models/user";
import { SoftException } from "../util";
import { UploadedFile } from "../models/uploadedFile";
import { type ProfileCropData, type ProfileStats } from "./user-profile-types";
import sharp from "sharp";
import { FileAccessStat } from "../models/stats/fileAccessStat";
import { SearchStat } from "../models/stats/searchStat";
import { DataSource, In, Repository } from "typeorm";
import { DirectoriesService } from "../directories/directories.service";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";

@Injectable()
export class UserProfileService {
   constructor(
      private readonly userService: AuthService,
      private readonly fileService: FilesService,
      private readonly directoryService: DirectoriesService,
      @InjectRepository(User) private readonly userRepo: Repository<User>,
      @InjectRepository(FileAccessStat) private readonly fileAccessStatRepo: Repository<FileAccessStat>,
      @InjectRepository(SearchStat) private readonly searchStatRepo: Repository<SearchStat>,
      @InjectRepository(UploadedFile) private readonly uploadedFileRepo: Repository<UploadedFile>,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly fs: AbstractFileSystem,
   ) {}

   // password + display-name changes moved to shado-auth-api (PATCH /auth/change/*).

   // Profile picture upload moved to shado-auth-api; storage is done via
   // saveProfilePictureForShado (called by the service endpoint) below.

   /** Save the authenticated user's profile picture (no password — auth forwards the upload as the user). */
   public async setProfilePicture(userId: number, file: Express.Multer.File, crop?: ProfileCropData) {
      const user = await this.userService.getById(userId);
      if (!user) throw new SoftException("User not found");
      const [ok, err] = await this.saveProfilePicture(user, file, crop as ProfileCropData);
      if (!ok) throw new SoftException((err as string) || "Failed to save picture");
   }

   /** Absolute path + mime of any user's avatar (by shado UUID) — for serving avatars to others. */
   public async avatarFileForUser(shadoUserId: string): Promise<{ absPath: string; mime: string } | null> {
      const user = await this.userService.getUser(shadoUserId);
      if (!user) return null;
      const info = await this.fileService.profilePictureInfo(user.id);
      if (!info.exists) return null;
      const absPath = await this.fileService.absolutePath(user.id, FilesService.METADATA_FOLDER_NAME + "/prof");
      const rec = await this.uploadedFileRepo.findOne({ where: { user: { id: user.id }, absolute_path: info.path } });
      return { absPath, mime: rec?.mime || "image/jpeg" };
   }

   public async getStats(userId: number, withDeleted = false) {
      const fileAccesMeta = this.fileAccessStatRepo.metadata;
      const uploadedFileMeta = this.uploadedFileRepo.metadata;
      const userTbMeta = this.userRepo.metadata;

      const most_accesed_files_raw = await this.fileAccessStatRepo.query(
         `
			SELECT SUM(T.count) AS Total, U.*
			FROM ${fileAccesMeta.tableName} AS T
			LEFT JOIN ${uploadedFileMeta.tableName} AS U ON T.${uploadedFileMeta.name}Id = U.id
			WHERE T.${userTbMeta.name}Id = ?
					${withDeleted ? "" : " AND T.deleted_at is null"}
			GROUP BY U.id
			ORDER BY Total DESC
			LIMIT 6 	-- Needed to ignore the profile picture access
		`,
         [userId],
      );

      const most_search_raw = await this.searchStatRepo
         .createQueryBuilder("search")
         .select("search.text", "text")
         .addSelect("COUNT(search.text)", "Total")
         .where(`search.${userTbMeta.name}Id = :id`, { id: userId })
         .groupBy("search.text")
         .orderBy("Total", "DESC")
         .limit(5)
         .getRawMany();

      const most_accesed_files: ProfileStats = {
         most_accesed_files: most_accesed_files_raw.map(({ Total, ...file }) => ({
            access_count: Total,
            file,
         })),
         most_searched: most_search_raw.map((e) => ({
            search_count: e.Total,
            search: { text: e.text } as any,
         })),
         used_data: await this.fileService.getUsedData(userId),
         cold_storage: await this.fileService.getColdStorageStats(userId),
      };

      return most_accesed_files;
   }

   public async indexFiles(userId: number, onProgress?: (current: number, total: number) => void) {
      const user = await this.userService.getById(userId);

      // Get current indexed files
      const currentIndexedFiles = await this.uploadedFileRepo.find({ where: { user: { id: userId } } });

      // Re-index all files
      const files = await this.directoryService.listrecursive(user.id);
      const newIndexedFiles: UploadedFile[] = [];
      for (const file of files) {
         const newFile = new UploadedFile();
         newFile.user = user;
         newFile.absolute_path = file;

         const mime: string =
            currentIndexedFiles.find((e) => path.normalize(e.absolute_path) == path.normalize(file))?.mime ??
            FilesService.detectFile(await this.fileService.absolutePath(userId, file));

         newFile.mime = mime;
         newIndexedFiles.push(await this.uploadedFileRepo.save(newFile));
         onProgress?.(newIndexedFiles.length, files.length);
      }

      // Get all references to the uploaded files (can't delete yet because of foreign key constraints)
      const fileAccessStats = await FileAccessStat.find({
         where: {
            uploaded_file: { id: In(currentIndexedFiles.map((e) => e.id)) },
         },
         relations: ["uploaded_file"],
      });
      for (const fileAccessStat of fileAccessStats) {
         const uploaded_file_new: UploadedFile | undefined = newIndexedFiles.find(
            (e) => path.normalize(e.absolute_path) == path.normalize(fileAccessStat.uploaded_file.absolute_path),
         );

         // If a new uploaded file was not found then this means
         // that the file does not physically exist anymore
         // In that case we have 2 options:
         // 1. Delete the file access stat
         // 2. Soft delete the old Uploaded file reference
         if (!uploaded_file_new) {
            // Decided to go with Removing the file access stat
            await this.fileAccessStatRepo.remove(fileAccessStat);
         } else {
            fileAccessStat.uploaded_file = uploaded_file_new;
            await this.fileAccessStatRepo.save(fileAccessStat);
         }
      }

      // Clear previous indexed files
      await UploadedFile.remove(currentIndexedFiles);

      return newIndexedFiles.length;
   }

   private async verifyPassword(userId: number, password: string): Promise<User> | never {
      const user = await this.userService.getById(userId);
      if (!user) throw new SoftException("User not found");

      const valid = await this.userService.verifyPassword(user.shadoUserId, password);
      if (!valid) {
         throw new SoftException("Invalid password");
      }

      return user;
   }

   private async saveProfilePicture(user: User, file: Express.Multer.File, crop: ProfileCropData) {
      // Create metadata folder
      await this.fileService.createMetaFolderIfNotExists(user.id);
      const userId = user.id;

      try {
         const root = await this.fileService.getUserRootPath(userId);
         const dir = await this.fileService.absolutePath(userId, FilesService.METADATA_FOLDER_NAME + "/prof");
         const relative = path.relative(root, dir);

         if (crop == undefined) {
            this.fs.writeFileSync(dir, file.buffer);
         } else {
            const image = sharp(file.buffer);
            const metadata = await image.metadata();
            const resizedImg = await image
               .extract({
                  top: Math.floor((crop.y / 100) * metadata.height),
                  left: Math.floor((crop.x / 100) * metadata.width),
                  width: Math.floor((crop.width / 100) * metadata.width),
                  height: Math.floor((crop.height / 100) * metadata.height),
               })
               .toBuffer();
            this.fs.writeFileSync(dir, resizedImg);
         }

         // Remove previous metadata prof indexed file
         await this.uploadedFileRepo.delete({ user, absolute_path: relative });

         const fileDB = new UploadedFile();
         fileDB.absolute_path = relative;
         fileDB.user = user;
         fileDB.mime = file.mimetype;
         await this.uploadedFileRepo.save(fileDB);

         return [true, ""];
      } catch (e) {
         return [false, (e as Error).message];
      }
   }
}
