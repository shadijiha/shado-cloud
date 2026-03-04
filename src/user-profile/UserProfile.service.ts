import { Inject, Injectable } from "@nestjs/common";
import argon2 from "argon2";
import path from "path";
import { AuthService } from "../auth/auth.service";
import { LoggerToDb } from "../logging";
import { User } from "../models/user";
import { SoftException } from "../util";
import { UploadedFile } from "../models/uploadedFile";
import { type ProfileCropData, type ProfileStats } from "./user-profile-types";
import sharp from "sharp";
import { FileAccessStat } from "../models/stats/fileAccessStat";
import { SearchStat } from "../models/stats/searchStat";
import { In, Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { StorageClient } from "../storage/storage.client";

@Injectable()
export class UserProfileService {
   constructor(
      private readonly userService: AuthService,
      private readonly storage: StorageClient,
      @InjectRepository(User) private readonly userRepo: Repository<User>,
      @InjectRepository(FileAccessStat) private readonly fileAccessStatRepo: Repository<FileAccessStat>,
      @InjectRepository(SearchStat) private readonly searchStatRepo: Repository<SearchStat>,
      @InjectRepository(UploadedFile) private readonly uploadedFileRepo: Repository<UploadedFile>,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly fs: AbstractFileSystem,
   ) {}

   public async changePassword(userId: number, old_password: string, new_password: string) {
      const user = await this.verifyPassword(userId, old_password);
      user.password = await argon2.hash(new_password);
      this.userRepo.save(user);
      this.logger.log("User changed their password");
   }

   public async changeName(userId: number, password: string, new_name: string) {
      const user = await this.verifyPassword(userId, password);
      user.name = new_name;
      this.userRepo.save(user);
   }

   public async changePicture(userId: number, password: string, file: Express.Multer.File, crop: ProfileCropData) {
      const user = await this.verifyPassword(userId, password);
      this.saveProfilePicture(user, file, crop);
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
			LIMIT 6
		`,
         [userId],
      );

      const most_search_raw = await this.searchStatRepo
         .createQueryBuilder("search")
         .addSelect("count(search.text) AS Total")
         .where(`search.${userTbMeta.name}Id = :id`, { id: userId })
         .groupBy("search.text")
         .orderBy("Total", "DESC")
         .limit(5)
         .getRawAndEntities();

      const most_accesed_files: ProfileStats = {
         most_accesed_files: most_accesed_files_raw.map(({ Total, ...file }) => ({
            access_count: Total,
            file,
         })),
         most_searched: most_search_raw.raw.map((e, i) => ({
            search_count: e.Total,
            search: most_search_raw.entities[i],
         })),
         used_data: await this.storage.getUsedData(userId),
      };

      return most_accesed_files;
   }

   public async indexFiles(userId: number) {
      const user = await this.userService.getById(userId);
      const currentIndexedFiles = await this.uploadedFileRepo.find({ where: { user: { id: userId } } });

      const files = await this.storage.dirListRecursive(user.id);
      const newIndexedFiles: UploadedFile[] = [];
      for (const file of files) {
         const newFile = new UploadedFile();
         newFile.user = user;
         newFile.absolute_path = file;

         const mime: string =
            currentIndexedFiles.find((e) => path.normalize(e.absolute_path) == path.normalize(file))?.mime ??
            (await this.storage.detectFile(await this.storage.absolutePath(userId, file)));

         newFile.mime = mime;
         newIndexedFiles.push(await this.uploadedFileRepo.save(newFile));
      }

      const fileAccessStats = await FileAccessStat.find({
         where: { uploaded_file: { id: In(currentIndexedFiles.map((e) => e.id)) } },
         relations: ["uploaded_file"],
      });
      for (const fileAccessStat of fileAccessStats) {
         const uploaded_file_new = newIndexedFiles.find(
            (e) => path.normalize(e.absolute_path) == path.normalize(fileAccessStat.uploaded_file.absolute_path),
         );
         if (!uploaded_file_new) {
            await this.fileAccessStatRepo.remove(fileAccessStat);
         } else {
            fileAccessStat.uploaded_file = uploaded_file_new;
            await this.fileAccessStatRepo.save(fileAccessStat);
         }
      }

      await UploadedFile.remove(currentIndexedFiles);
      return newIndexedFiles.length;
   }

   private async verifyPassword(userId: number, password: string): Promise<User> | never {
      const user = await this.userService.getWithPassword(userId);
      if (!(await argon2.verify(user.password, password))) {
         throw new SoftException("Invalid password");
      }
      return user;
   }

   private async saveProfilePicture(user: User, file: Express.Multer.File, crop: ProfileCropData) {
      await this.storage.createMetaFolder(user.id);
      const userId = user.id;

      try {
         const root = await this.storage.getUserRootPath(userId);
         const dir = await this.storage.absolutePath(userId, ".metadata/prof");
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

         await this.uploadedFileRepo.delete({ user, absolute_path: relative });

         const fileDB = new UploadedFile();
         fileDB.absolute_path = relative;
         fileDB.user = user;
         fileDB.mime = file.mimetype;
         this.uploadedFileRepo.save(fileDB);

         return [true, ""];
      } catch (e) {
         return [false, (e as Error).message];
      }
   }
}
