import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { STORAGE_SERVICE, StoragePatterns } from "./storage.patterns";

/**
 * TCP client proxy for the Storage microservice.
 * Inject this anywhere in the main app that previously used FilesService/DirectoriesService/TempUrlService directly.
 */
@Injectable()
export class StorageClient {
   constructor(@Inject(STORAGE_SERVICE) private readonly client: ClientProxy) {}

   // ─── Files ────────────────────────────────────────────────────────

   fileUpload(userId: number, file: Express.Multer.File, dest: string) {
      return firstValueFrom(
         this.client.send(StoragePatterns.FILE_UPLOAD, {
            userId,
            file: { originalname: file.originalname, buffer: Array.from(file.buffer), mimetype: file.mimetype, size: file.size },
            dest,
         }),
      );
   }

   fileNew(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_NEW, { userId, name }));
   }

   fileSave(userId: number, name: string, content: string, append?: boolean | string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_SAVE, { userId, name, content, append }));
   }

   fileDelete(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_DELETE, { userId, name }));
   }

   fileRename(userId: number, name: string, newName: string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_RENAME, { userId, name, newName }));
   }

   fileInfo(userId: number, path: string, fetchRedisKeys = false, fetchDbRecords = false) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_INFO, { userId, path, fetchRedisKeys, fetchDbRecords }));
   }

   fileExists(userId: number, path: string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_EXISTS, { userId, path }));
   }

   fileStream(userId: number, path: string, userAgent: string, range?: { start: number; end: number }): Promise<{ buffer: number[]; info: any }> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_STREAM, { userId, path, userAgent, range }));
   }

   fileThumbnail(userId: number, path: string, width?: number, height?: number): Promise<number[] | null> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_THUMBNAIL, { userId, path, width, height }));
   }

   profilePictureInfo(userId: number) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_PROFILE_PICTURE_INFO, { userId }));
   }

   getUsedData(userId: number) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_GET_USED_DATA, { userId }));
   }

   getUserRootPath(userId: number): Promise<string> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_GET_USER_ROOT_PATH, { userId }));
   }

   absolutePath(userId: number, relativePath: string): Promise<string> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_ABSOLUTE_PATH, { userId, relativePath }));
   }

   isOwner(userId: number, absolutePath: string): Promise<boolean> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_IS_OWNER, { userId, absolutePath }));
   }

   detectFile(filename: string): Promise<string> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_DETECT, { filename }));
   }

   createMetaFolder(userId: number): Promise<string> {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_CREATE_META_FOLDER, { userId }));
   }

   verifyFileName(fullpath: string) {
      return firstValueFrom(this.client.send(StoragePatterns.FILE_VERIFY_FILE_NAME, { fullpath }));
   }

   // ─── Directories ──────────────────────────────────────────────────

   dirRoot(userId: number): Promise<string> {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_ROOT, { userId }));
   }

   dirList(userId: number, path?: string, fetchRedisKeys?: boolean, fetchDbRecords?: boolean) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_LIST, { userId, path, fetchRedisKeys, fetchDbRecords }));
   }

   dirListRecursive(userId: number, showHidden?: boolean): Promise<string[]> {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_LIST_RECURSIVE, { userId, showHidden }));
   }

   dirNew(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_NEW, { userId, name }));
   }

   dirDelete(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_DELETE, { userId, name }));
   }

   dirRename(userId: number, name: string, newName: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_RENAME, { userId, name, newName }));
   }

   dirSearch(userId: number, searchText: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_SEARCH, { userId, searchText }));
   }

   dirZip(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_ZIP, { userId, name }));
   }

   dirUnzip(userId: number, name: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_UNZIP, { userId, name }));
   }

   dirCreateUserDir(email: string) {
      return firstValueFrom(this.client.send(StoragePatterns.DIR_CREATE_USER_DIR, { email }));
   }

   // ─── Temp URLs ────────────────────────────────────────────────────

   tempGenerate(headers: any, userId: number, filepath: string, maxRequests: number, expiresAt: Date, isReadonly: boolean): Promise<string> {
      return firstValueFrom(
         this.client.send(StoragePatterns.TEMP_GENERATE, {
            headers, userId, filepath, maxRequests, expiresAt: expiresAt.toISOString(), isReadonly,
         }),
      );
   }

   tempStream(tempUrl: string): Promise<{ buffer: number[]; filename: string; info: any }> {
      return firstValueFrom(this.client.send(StoragePatterns.TEMP_STREAM, { tempUrl }));
   }

   tempSave(tempUrl: string, content: string, append?: boolean) {
      return firstValueFrom(this.client.send(StoragePatterns.TEMP_SAVE, { tempUrl, content, append }));
   }

   tempList(userId: number) {
      return firstValueFrom(this.client.send(StoragePatterns.TEMP_LIST, { userId }));
   }

   tempDelete(userId: number, key: string) {
      return firstValueFrom(this.client.send(StoragePatterns.TEMP_DELETE, { userId, key }));
   }
}
