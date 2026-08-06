import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createReadStream, existsSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { AuthService } from "src/auth/auth.service";
import { FilesService } from "src/files/files.service";
import { DirectoriesService } from "src/directories/directories.service";
import { type DirectoryInfo } from "src/directories/directoriesApiTypes";
import { type FileInfo } from "src/files/filesApiTypes";
import { TempUrl, TempUrlAccessLevel } from "src/models/tempUrl";
import { SoftException } from "src/util";
import { type Request } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { EnvVariables } from "../config/config.validator";
import { ConfigService } from "@nestjs/config";
import { TempURLDirEntry, TempURLListResponse, TempURLMetaResponse } from "./tempUrlApiTypes";

@Injectable()
export class TempUrlService {
   constructor(
      private readonly fileService: FilesService,
      private readonly userService: AuthService,
      @Inject() private readonly directoriesService: DirectoriesService,
      @InjectRepository(TempUrl) private readonly tempUrlRepo: Repository<TempUrl>,
      @Inject() private readonly fs: AbstractFileSystem,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) { }

   public async generate(
      request: Request,
      userId: number,
      filepath: string,
      max_requests: number,
      expires_at: Date,
      is_readonly: boolean,
      access_level: TempUrlAccessLevel = TempUrlAccessLevel.PUBLIC,
   ): Promise<string> {
      // A temp URL may only ever point at a file/dir the generating user actually owns.
      // Without this check, a user could pass a traversal path (e.g. "../<other-user>/file"
      // or "../../../../etc/...") that absolutePath() would resolve OUTSIDE their own root,
      // turning the (publicly reachable) /temp/:url/save endpoint into a cross-user /
      // arbitrary file write primitive. Validate against the resolved absolute path.
      const absolutePath = await this.fileService.absolutePath(userId, filepath);
      if (!(await this.fileService.isOwner(userId, absolutePath))) {
         throw new SoftException("You do not have permission to create a temporary URL for this file");
      }

      if (!existsSync(absolutePath)) {
         throw new SoftException("The file or directory to share does not exist");
      }

      // Validate the requested access level. "restricted" is a planned feature with no
      // enforcement yet, so reject it to avoid creating a share that would silently
      // behave like "authenticated" (a security foot-gun).
      if (!Object.values(TempUrlAccessLevel).includes(access_level)) {
         access_level = TempUrlAccessLevel.PUBLIC;
      }
      if (access_level === TempUrlAccessLevel.RESTRICTED) {
         throw new SoftException("Restricted-user shares are not supported yet");
      }

      // Determine (server-side, never trusted from the client) whether the share points
      // at a directory — directory shares are browsed through the frontend explorer.
      const is_dir = this.fs.statSync(absolutePath).isDirectory();

      // A directory can never be written to through a share link — browsing/downloading
      // only. Force read-only so the (public) save endpoint can never mutate a dir share.
      if (is_dir) {
         is_readonly = true;
      }

      const tempUrl = new TempUrl();
      tempUrl.user = await this.userService.getById(userId);
      tempUrl.url = this.makeUrl();
      tempUrl.max_requests = max_requests;
      tempUrl.expires_at = expires_at;
      tempUrl.filepath = filepath;
      tempUrl.is_readonly = is_readonly;
      tempUrl.is_dir = is_dir;
      tempUrl.access_level = access_level;
      await this.tempUrlRepo.save(tempUrl);

      // Directory shares open the frontend file explorer; single-file shares keep the
      // direct backend download/stream link (backwards compatible).
      if (is_dir) {
         return `${this.frontendBaseUrl(request)}/share/${tempUrl.url}`;
      }
      return `${request.protocol}://${request.headers.host}/temp/${tempUrl.url}/get`;
   }

   /**
    * Streams a shared file. For directory shares, `subPath` selects a file within the
    * shared directory (traversal-safe). For single-file shares `subPath` must be empty.
    */
   public async asStream(tempUrl: string, subPath = "", cookies?: string) {
      const temp = await this.findOrThrow(tempUrl);
      await this.assertAuthorized(temp, cookies);

      if (!this.verifyUrlConditions(temp)) {
         throw new SoftException("Max requests exhausted OR temporary URL expired OR url is readonly");
      }

      const { absPath, relFromRoot } = await this.resolveTarget(temp, subPath);

      if (!existsSync(absPath)) {
         throw new SoftException("File referenced by temp URL no longer exists");
      }
      // A directory itself cannot be streamed — the caller must select a file within it.
      if (this.fs.statSync(absPath).isDirectory()) {
         throw new SoftException("Requested path is a directory, not a file");
      }

      temp.requests += 1;
      await this.tempUrlRepo.save(temp);

      return {
         stream: createReadStream(absPath),
         filename: path.basename(relFromRoot),
         info: await this.fileService.info(temp.user.id, relFromRoot),
      };
   }

   public async save(tempUrl: string, content: string, append = false, subPath = "", cookies?: string) {
      const temp = await this.findOrThrow(tempUrl);
      await this.assertAuthorized(temp, cookies);

      // Directory shares are always browse/download only — never writable.
      if (temp.is_dir) {
         throw new SoftException("Directory shares are read-only and cannot be modified");
      }

      if (!this.verifyUrlConditions(temp, true)) {
         throw new SoftException("Max requests exhausted OR temporary URL expired OR url is readonly");
      }

      const { absPath } = await this.resolveTarget(temp, subPath);

      // Check if file still exists
      if (!existsSync(absPath)) {
         throw new SoftException("File referenced by temp URL no longer exists");
      }
      if (this.fs.statSync(absPath).isDirectory()) {
         throw new SoftException("Requested path is a directory, not a file");
      }

      temp.requests += 1;
      await this.tempUrlRepo.save(temp);

      if (append) {
         this.fs.appendFileSync(absPath, content);
      } else {
         this.fs.writeFileSync(absPath, content);
      }
   }

   /**
    * Lightweight metadata for the public explorer. Does NOT consume the request quota so
    * a user can inspect a share (and browse) without burning downloads.
    */
   public async meta(tempUrl: string, cookies?: string): Promise<TempURLMetaResponse> {
      const temp = await this.findOrThrow(tempUrl);
      await this.assertAuthorized(temp, cookies);

      const name = temp.filepath ? path.basename(temp.filepath) : "/";
      let mime: string | null = null;
      if (!temp.is_dir) {
         try {
            mime = FilesService.detectFile(await this.fileService.absolutePath(temp.user.id, temp.filepath));
         } catch {
            mime = null;
         }
      }

      return {
         url: temp.url,
         is_dir: temp.is_dir,
         is_readonly: temp.is_readonly,
         access_level: temp.access_level ?? TempUrlAccessLevel.PUBLIC,
         is_valid: temp.isValid(),
         name,
         mime,
         requests: temp.requests,
         max_requests: temp.max_requests,
         expires_at: temp.expires_at,
      };
   }

   /**
    * Lists the contents of `subPath` within a shared directory. Browsing does not consume
    * the request quota (only actual file downloads via {@link asStream} do).
    */
   public async listDir(tempUrl: string, subPath = "", cookies?: string): Promise<TempURLListResponse> {
      const temp = await this.findOrThrow(tempUrl);
      await this.assertAuthorized(temp, cookies);

      if (!temp.is_dir) {
         throw new SoftException("This shared link is a single file, not a directory");
      }
      if (!this.verifyUrlConditions(temp)) {
         throw new SoftException("Max requests exhausted OR temporary URL expired");
      }

      const { absPath, relFromRoot } = await this.resolveTarget(temp, subPath);
      if (!existsSync(absPath) || !this.fs.statSync(absPath).isDirectory()) {
         throw new SoftException("Requested path is not a directory");
      }
      const shareRoot = await this.fileService.absolutePath(temp.user.id, temp.filepath);

      // Delegate the actual enumeration (readdir + sort + per-file info()) to
      // DirectoriesService.list — the same code the authenticated file browser uses — so
      // this method only owns the share-specific concerns (token/auth/quota checks,
      // share-root traversal safety, dot-file hiding and share-relative paths).
      // list() paginates (max 200/page); walk all pages so a share still exposes the whole
      // directory.
      const listed: Array<DirectoryInfo | FileInfo> = [];
      let page = 1;
      let totalPages = 1;
      do {
         const { paginatedItems, paginationMetadata } = await this.directoriesService.list(
            temp.user.id,
            relFromRoot,
            false,
            false,
            { page, limit: 200 },
            [["name", "ASC"]],
         );
         listed.push(...paginatedItems);
         totalPages = paginationMetadata.totalPages;
         page++;
      } while (page <= totalPages);

      const entries: TempURLDirEntry[] = [];
      for (const item of listed) {
         // Hide dot-files/dirs from public shares.
         if (item.name.startsWith(".")) continue;

         // DirectoriesService returns paths relative to the *user root*; for a directory
         // entry `path` is the parent listing dir (name holds the folder). Rebuild the
         // entry's full path, then express it relative to the *share root*.
         const userRelPath = item.is_dir ? path.join(item.path, item.name) : item.path;
         const sharePath = path.relative(temp.filepath, userRelPath);

         if (item.is_dir) {
            entries.push({
               name: item.name,
               is_dir: true,
               path: sharePath,
               lastModified: item.lastModified,
               extension: "",
               is_image: false,
               is_video: false,
               is_audio: false,
               is_pdf: false,
               is_text: false,
            });
         } else {
            const file = item as FileInfo;
            entries.push({
               name: file.name,
               is_dir: false,
               path: sharePath,
               size: file.size,
               mime: file.mime,
               lastModified: file.lastModified,
               extension: file.extension,
               is_image: file.is_image,
               is_video: file.is_video,
               is_audio: file.is_audio,
               is_pdf: file.is_pdf,
               is_text: file.is_text,
            });
         }
      }

      return {
         url: temp.url,
         // Sub-path relative to the share root ("" == the share root itself).
         path: path.relative(shareRoot, absPath),
         entries,
         errors: [],
      };
   }

   /**
    * Returns a resized thumbnail stream for an image/video within the share, reusing the
    * authenticated file thumbnail pipeline (FilesService.toThumbnail) so the public
    * explorer can render the same thumbnails as the logged-in browser. Does not consume
    * the request quota.
    */
   public async thumbnail(
      tempUrl: string,
      subPath = "",
      width?: number,
      height?: number,
      cookies?: string,
   ) {
      const temp = await this.findOrThrow(tempUrl);
      await this.assertAuthorized(temp, cookies);

      if (!this.verifyUrlConditions(temp)) {
         throw new SoftException("Max requests exhausted OR temporary URL expired");
      }

      const { relFromRoot } = await this.resolveTarget(temp, subPath);
      // toThumbnail re-validates ownership against temp.user.id.
      return this.fileService.toThumbnail(relFromRoot, temp.user.id, width, height);
   }

   public async all(userId: number) {
      return (await this.tempUrlRepo.find({ where: { user: { id: userId } } })).map((e) => {
         return {
            ...e,
            is_valid: e.isValid(),
         };
      });
   }

   public async delete(userId: number, key: any) {
      const user = await this.userService.getById(userId);
      const tempUrl = await this.tempUrlRepo.findOne({
         where: { url: key },
         relations: ["user"],
      });

      if (!tempUrl) {
         throw new SoftException("Invalid temporary URL " + tempUrl.url);
      }

      // Check if user owns temp url
      if (user.id != tempUrl.user.id) {
         throw new SoftException("Cannot delete a temprary URL you don't own");
      }

      // Otherwise delete
      await this.tempUrlRepo.delete(tempUrl.id);
   }

   private async findOrThrow(tempUrl: string): Promise<TempUrl> {
      const temp = await this.tempUrlRepo.findOne({
         where: { url: tempUrl },
         relations: ["user"],
      });
      if (!temp) {
         throw new SoftException("Invalid temporary URL");
      }
      return temp;
   }

   /**
    * Enforce the share's access level. "public" shares need nothing; "authenticated"
    * (and, until per-user enforcement lands, "restricted") shares require any valid Shado
    * session cookie — otherwise a 401 is raised so the frontend can redirect to login.
    */
   private async assertAuthorized(temp: TempUrl, cookies?: string): Promise<void> {
      const level = temp.access_level ?? TempUrlAccessLevel.PUBLIC;
      if (level === TempUrlAccessLevel.PUBLIC) return;
      if (!cookies) {
         throw new UnauthorizedException("This shared link requires you to be logged in");
      }
      const shadoUserId = await this.userService.validateCookies(cookies);
      if (!shadoUserId) {
         throw new UnauthorizedException("This shared link requires you to be logged in");
      }
   }

   /**
    * Resolve a (possibly nested) sub-path within a share to an absolute path, guaranteeing
    * the result never escapes the shared root and always stays inside the owner's storage.
    * Returns both the absolute path and the path relative to the owner's root (for info()).
    */
   private async resolveTarget(temp: TempUrl, subPath: string): Promise<{ absPath: string; relFromRoot: string }> {
      let relFromRoot = temp.filepath;

      if (temp.is_dir) {
         const base = await this.fileService.absolutePath(temp.user.id, temp.filepath);
         const target = path.resolve(base, subPath || "");
         const within = path.relative(base, target);
         if (within.startsWith("..") || path.isAbsolute(within)) {
            throw new SoftException("Invalid path within shared directory");
         }
         const userRoot = await this.fileService.absolutePath(temp.user.id, "");
         relFromRoot = path.relative(userRoot, target);
      } else if (subPath) {
         // A single-file share has no browsable children.
         throw new SoftException("This shared link is a single file");
      }

      const absPath = await this.fileService.absolutePath(temp.user.id, relFromRoot);

      // Defense-in-depth: even though generate() validates ownership, re-verify here so a
      // stored traversal filepath can never read/write outside the owner's root (these
      // endpoints are publicly reachable and have no auth guard of their own).
      if (!(await this.fileService.isOwner(temp.user.id, absPath))) {
         throw new SoftException("Temporary URL references a path outside the owner's storage");
      }

      return { absPath, relFromRoot };
   }

   /**
    * Base URL of the cloud frontend for building share links. `frontend_url` may hold
    * several comma-separated origins (e.g. cloud + music frontends), so prefer the one
    * that mentions "cloud"; otherwise fall back to the first entry (dev sets a single URL).
    */
   private frontendBaseUrl(request: Request): string {
      const configured = this.config
         .get("this-service.frontend_url", { infer: true })
         ?.split(",")
         .map((s) => s.trim())
         .filter(Boolean);

      if (configured && configured.length > 0) {
         const preferred = configured.find((u) => u.toLowerCase().includes("cloud")) ?? configured[0];
         return preferred.replace(/\/+$/, "");
      }
      return `${request.protocol}://${request.headers.host}`;
   }

   private verifyUrlConditions(tempUrl: TempUrl, readAndWrite = false) {
      return (
         tempUrl.requests < tempUrl.max_requests &&
         (readAndWrite ? !tempUrl.is_readonly : true) &&
         new Date() < tempUrl.expires_at
      );
   }

   private makeUrl(length = 64) {
      // Security: this token is the ONLY secret protecting a temp URL (the /temp/:url
      // endpoints have no auth guard). It must be unguessable, so use a CSPRNG
      // (crypto.randomBytes) rather than Math.random(), which is not cryptographically
      // secure and can be predicted from a few outputs.
      //
      // Length: 64 chars over a 62-char alphabet (~381 bits of entropy) makes the token
      // impossible to brute-force or enumerate, and long/random enough that it will never
      // be discovered or indexed by search-engine crawlers (which only follow links they
      // can find, never guess opaque tokens).
      const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const charactersLength = characters.length;
      // Rejection sampling to avoid modulo bias across the 62-char alphabet.
      const max = 256 - (256 % charactersLength);
      let result = "";
      while (result.length < length) {
         for (const byte of randomBytes(length)) {
            if (byte >= max) continue; // discard biased bytes
            result += characters.charAt(byte % charactersLength);
            if (result.length === length) break;
         }
      }
      return result;
   }
}
