import {
   Body,
   Controller,
   Get,
   Inject,
   MessageEvent,
   Param,
   Put,
   Query,
   Res,
   Sse,
   UploadedFile,
   UseGuards,
   UseInterceptors,
   ValidationPipe,
} from "@nestjs/common";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { FileInterceptor } from "@nestjs/platform-express/multer";
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { OperationStatusResponse } from "src/files/filesApiTypes";
import { LoggerToDb } from "./../logging";
import { AuthUser } from "src/util";
import { ProfileStats } from "./user-profile-types";
import { UserProfileService } from "./UserProfile.service";
import { Observable, Subject } from "rxjs";

@Controller("profile")
@UseGuards(JwtAuthGuard)
@ApiTags("User profile settings")
export class UserProfileController {
   /** Maximum accepted profile picture size (bytes). */
   static readonly MAX_PROFILE_PIC_BYTES = 5 * 1024 * 1024; // 5 MB
   constructor(private readonly profileService: UserProfileService, @Inject() private readonly logger: LoggerToDb, @Inject() private readonly fs: AbstractFileSystem) {}

   /** Serve any user's avatar by their auth (shado) UUID — any logged-in user may view it (for friends, search, etc.). */
   @Get("picture/:shadoUserId")
   @ApiParam({ name: "shadoUserId" })
   public async getPicture(@Param("shadoUserId") shadoUserId: string, @Res() res: Response) {
      const f = await this.profileService.avatarFileForUser(shadoUserId);
      if (!f) {
         res.status(404).send();
         return;
      }
      res.setHeader("Content-Type", f.mime);
      res.setHeader("Cache-Control", "private, max-age=60");
      this.fs.createReadStream(f.absPath).pipe(res);
   }

   // NOTE: password + display-name changes now live in shado-auth-api
   // (PATCH /auth/change/password, /auth/change/name).

   /**
    * Save the user's profile picture (crop done here with sharp). shado-auth-api owns the
    * user-facing endpoint and forwards the upload here as the authenticated user, so the
    * picture lands in this user's own .metadata/prof — treated like any other file.
    */
   @Put("picture")
   @UseInterceptors(FileInterceptor("file", { limits: { fileSize: UserProfileController.MAX_PROFILE_PIC_BYTES } }))
   @ApiResponse({ type: OperationStatusResponse })
   public async setPicture(@AuthUser() userId: number, @UploadedFile() file: Express.Multer.File, @Body() body: { crop?: string }) {
      return await this.logger.errorWrapper(async () => {
         if (!file) throw new Error("No image provided");
         if (!file.mimetype?.startsWith("image/")) throw new Error("Only image files are allowed");
         await this.profileService.setProfilePicture(
            userId,
            file,
            body.crop && body.crop !== "undefined" ? JSON.parse(body.crop) : undefined,
         );
      });
   }

   @Get("stats")
   @ApiQuery({ name: "with_deleted", required: false })
   @ApiResponse({ type: ProfileStats })
   public async getStats(
      @AuthUser() userId: number,
      @Query("with_deleted", new ValidationPipe({ transform: true }))
      with_deleted: boolean = false,
   ) {
      return await this.logger.errorWrapper(async () => {
         return await this.profileService.getStats(userId, with_deleted);
      });
   }

   @Sse("indexfiles")
   public indexFiles(@AuthUser() userId: number): Observable<MessageEvent> {
      const subject = new Subject<MessageEvent>();

      this.profileService.indexFiles(userId, (current, total) => {
         subject.next({ data: { current, total, percent: Math.round((current / total) * 100) } });
      }).then((count) => {
         subject.next({ data: { done: true, reindexCount: count } });
         subject.complete();
      }).catch((e) => {
         subject.next({ data: { error: e.message } });
         subject.complete();
      });

      return subject.asObservable();
   }
}
