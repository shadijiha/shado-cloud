import { Controller } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { FilesService } from "../files/files.service";
import { DirectoriesService } from "../directories/directories.service";
import { TempUrlService } from "../temp-url/tempUrl.service";
import { StoragePatterns } from "./storage.patterns";

@Controller()
export class StorageMicroserviceController {
   constructor(
      private readonly filesService: FilesService,
      private readonly dirService: DirectoriesService,
      private readonly tempUrlService: TempUrlService,
   ) {}

   // ─── Files ────────────────────────────────────────────────────────

   @MessagePattern(StoragePatterns.FILE_UPLOAD)
   async fileUpload(@Payload() data: { userId: number; file: { originalname: string; buffer: number[]; mimetype: string; size: number }; dest: string }) {
      const file = {
         ...data.file,
         buffer: Buffer.from(data.file.buffer),
      } as Express.Multer.File;
      await this.filesService.upload(data.userId, file, data.dest);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.FILE_NEW)
   async fileNew(@Payload() data: { userId: number; name: string }) {
      await this.filesService.new(data.userId, data.name);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.FILE_SAVE)
   async fileSave(@Payload() data: { userId: number; name: string; content: string; append?: boolean | string }) {
      const [success, message] = await this.filesService.save(data.userId, data.name, data.content, data.append);
      return { success, message };
   }

   @MessagePattern(StoragePatterns.FILE_DELETE)
   async fileDelete(@Payload() data: { userId: number; name: string }) {
      const [success, message] = await this.filesService.delete(data.userId, data.name);
      return { success, message };
   }

   @MessagePattern(StoragePatterns.FILE_RENAME)
   async fileRename(@Payload() data: { userId: number; name: string; newName: string }) {
      await this.filesService.rename(data.userId, data.name, data.newName);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.FILE_INFO)
   async fileInfo(@Payload() data: { userId: number; path: string; fetchRedisKeys?: boolean; fetchDbRecords?: boolean }) {
      return await this.filesService.info(data.userId, data.path, data.fetchRedisKeys ?? false, data.fetchDbRecords ?? false);
   }

   @MessagePattern(StoragePatterns.FILE_EXISTS)
   async fileExists(@Payload() data: { userId: number; path: string }) {
      return await this.filesService.exists(data.userId, data.path);
   }

   @MessagePattern(StoragePatterns.FILE_STREAM)
   async fileStream(@Payload() data: { userId: number; path: string; userAgent: string; range?: { start: number; end: number } }) {
      const stream = await this.filesService.asStream(data.userId, data.path, data.userAgent, data.range);
      return new Promise<{ buffer: number[]; info: any }>((resolve, reject) => {
         const chunks: Buffer[] = [];
         stream.on("data", (chunk) => chunks.push(chunk));
         stream.on("end", async () => {
            const info = await this.filesService.info(data.userId, data.path, false, false);
            resolve({ buffer: Array.from(Buffer.concat(chunks)), info });
         });
         stream.on("error", reject);
      });
   }

   @MessagePattern(StoragePatterns.FILE_THUMBNAIL)
   async fileThumbnail(@Payload() data: { userId: number; path: string; width?: number; height?: number }) {
      const stream = await this.filesService.toThumbnail(data.path, data.userId, data.width, data.height);
      if (!stream) return null;
      return new Promise<number[]>((resolve, reject) => {
         const chunks: Buffer[] = [];
         stream.on("data", (chunk) => chunks.push(chunk));
         stream.on("end", () => resolve(Array.from(Buffer.concat(chunks))));
         stream.on("error", reject);
      });
   }

   @MessagePattern(StoragePatterns.FILE_PROFILE_PICTURE_INFO)
   async profilePictureInfo(@Payload() data: { userId: number }) {
      return await this.filesService.profilePictureInfo(data.userId);
   }

   @MessagePattern(StoragePatterns.FILE_GET_USED_DATA)
   async getUsedData(@Payload() data: { userId: number }) {
      return await this.filesService.getUsedData(data.userId);
   }

   @MessagePattern(StoragePatterns.FILE_GET_USER_ROOT_PATH)
   async getUserRootPath(@Payload() data: { userId: number }) {
      return await this.filesService.getUserRootPath(data.userId);
   }

   @MessagePattern(StoragePatterns.FILE_ABSOLUTE_PATH)
   async absolutePath(@Payload() data: { userId: number; relativePath: string }) {
      return await this.filesService.absolutePath(data.userId, data.relativePath);
   }

   @MessagePattern(StoragePatterns.FILE_IS_OWNER)
   async isOwner(@Payload() data: { userId: number; absolutePath: string }) {
      return await this.filesService.isOwner(data.userId, data.absolutePath);
   }

   @MessagePattern(StoragePatterns.FILE_DETECT)
   detectFile(@Payload() data: { filename: string }) {
      return FilesService.detectFile(data.filename);
   }

   @MessagePattern(StoragePatterns.FILE_CREATE_META_FOLDER)
   async createMetaFolder(@Payload() data: { userId: number }) {
      return await this.filesService.createMetaFolderIfNotExists(data.userId);
   }

   @MessagePattern(StoragePatterns.FILE_VERIFY_FILE_NAME)
   verifyFileName(@Payload() data: { fullpath: string }) {
      this.filesService.verifyFileName(data.fullpath);
      return { success: true };
   }

   // ─── Directories ──────────────────────────────────────────────────

   @MessagePattern(StoragePatterns.DIR_ROOT)
   async dirRoot(@Payload() data: { userId: number }) {
      return await this.dirService.root(data.userId);
   }

   @MessagePattern(StoragePatterns.DIR_LIST)
   async dirList(@Payload() data: { userId: number; path?: string; fetchRedisKeys?: boolean; fetchDbRecords?: boolean }) {
      return await this.dirService.list(data.userId, data.path ?? "", data.fetchRedisKeys, data.fetchDbRecords);
   }

   @MessagePattern(StoragePatterns.DIR_LIST_RECURSIVE)
   async dirListRecursive(@Payload() data: { userId: number; showHidden?: boolean }) {
      return await this.dirService.listrecursive(data.userId, data.showHidden);
   }

   @MessagePattern(StoragePatterns.DIR_NEW)
   async dirNew(@Payload() data: { userId: number; name: string }) {
      await this.dirService.new(data.userId, data.name);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.DIR_DELETE)
   async dirDelete(@Payload() data: { userId: number; name: string }) {
      await this.dirService.delete(data.userId, data.name);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.DIR_RENAME)
   async dirRename(@Payload() data: { userId: number; name: string; newName: string }) {
      await this.dirService.rename(data.userId, data.name, data.newName);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.DIR_SEARCH)
   async dirSearch(@Payload() data: { userId: number; searchText: string }) {
      return await this.dirService.search(data.userId, data.searchText);
   }

   @MessagePattern(StoragePatterns.DIR_ZIP)
   async dirZip(@Payload() data: { userId: number; name: string }) {
      this.dirService.zip(data.userId, data.name).catch(() => {});
      return { success: true };
   }

   @MessagePattern(StoragePatterns.DIR_UNZIP)
   async dirUnzip(@Payload() data: { userId: number; name: string }) {
      this.dirService.unzip(data.userId, data.name).catch(() => {});
      return { success: true };
   }

   @MessagePattern(StoragePatterns.DIR_CREATE_USER_DIR)
   async dirCreateUserDir(@Payload() data: { email: string }) {
      // Minimal user object — createNewUserDir only needs email
      await this.dirService.createNewUserDir({ email: data.email } as any);
      return { success: true };
   }

   // ─── Temp URLs ────────────────────────────────────────────────────

   @MessagePattern(StoragePatterns.TEMP_GENERATE)
   async tempGenerate(@Payload() data: {
      headers: any; userId: number; filepath: string;
      maxRequests: number; expiresAt: string; isReadonly: boolean;
   }) {
      return await this.tempUrlService.generate(
         data.headers, data.userId, data.filepath,
         data.maxRequests, new Date(data.expiresAt), data.isReadonly,
      );
   }

   @MessagePattern(StoragePatterns.TEMP_STREAM)
   async tempStream(@Payload() data: { tempUrl: string }) {
      const result = await this.tempUrlService.asStream(data.tempUrl);
      return new Promise<{ buffer: number[]; filename: string; info: any }>((resolve, reject) => {
         const chunks: Buffer[] = [];
         result.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
         result.stream.on("end", () => resolve({
            buffer: Array.from(Buffer.concat(chunks)),
            filename: result.filename,
            info: result.info,
         }));
         result.stream.on("error", reject);
      });
   }

   @MessagePattern(StoragePatterns.TEMP_SAVE)
   async tempSave(@Payload() data: { tempUrl: string; content: string; append?: boolean }) {
      await this.tempUrlService.save(data.tempUrl, data.content, data.append);
      return { success: true };
   }

   @MessagePattern(StoragePatterns.TEMP_LIST)
   async tempList(@Payload() data: { userId: number }) {
      return await this.tempUrlService.all(data.userId);
   }

   @MessagePattern(StoragePatterns.TEMP_DELETE)
   async tempDelete(@Payload() data: { userId: number; key: string }) {
      await this.tempUrlService.delete(data.userId, data.key);
      return { success: true };
   }
}
