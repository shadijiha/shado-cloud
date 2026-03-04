import {
   Body,
   Controller,
   Delete,
   Get,
   Inject,
   Param,
   Patch,
   Post,
   Query,
   Req,
   Res,
   StreamableFile,
   UploadedFile,
   UseGuards,
   UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { LoggerToDb } from "./../logging";
import { ApiFile, AuthUser } from "src/util";
import {
   FileInfoResponse,
   NewFileRequest,
   OperationStatus,
   OperationStatusResponse,
   OpResWithData,
   RenameFileRequest,
   SaveFileRequest,
} from "./filesApiTypes";
import { StorageClient } from "../storage/storage.client";

@Controller("file")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Files")
export class FilesConstoller {
   constructor(
      private readonly storage: StorageClient,
      @Inject() private readonly logger: LoggerToDb,
   ) {}

   @Post("upload")
   @ApiResponse({ type: OperationStatusResponse })
   @ApiConsumes("multipart/form-data")
   @ApiFile()
   @UseInterceptors(FileInterceptor("file"))
   public async upload(
      @AuthUser() userId: number,
      @UploadedFile() file: Express.Multer.File,
      @Body() body: { dest: string },
   ) {
      return await this.logger.errorWrapper(async () => {
         await this.storage.fileUpload(userId, file, body.dest);
      });
   }

   @Post("new")
   @ApiResponse({ type: OperationStatusResponse })
   public async new(@Body() body: NewFileRequest, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      return await this.logger.errorWrapper(async () => {
         await this.storage.fileNew(userId, body.name);
      });
   }

   @Patch("save")
   @ApiResponse({ type: OperationStatusResponse })
   public async save(@Body() body: SaveFileRequest, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      const result = await this.storage.fileSave(userId, body.name, body.content, body.append);
      if (result.success) {
         return { status: OperationStatus[OperationStatus.SUCCESS], errors: [] };
      } else {
         this.logger.logException(new Error(result.message));
         return { status: OperationStatus[OperationStatus.FAILED], errors: [{ field: "", message: result.message }] };
      }
   }

   @Delete("delete")
   @ApiResponse({ type: OperationStatusResponse })
   public async delete(@Body() body: NewFileRequest, @AuthUser() userId: number) {
      const result = await this.storage.fileDelete(userId, body.name);
      if (result.success) {
         return { status: OperationStatus[OperationStatus.SUCCESS], errors: [] };
      } else {
         this.logger.logException(new Error(result.message));
         return { status: OperationStatus[OperationStatus.FAILED], errors: [{ field: "", message: result.message }] };
      }
   }

   @Patch("rename")
   @ApiResponse({ type: OperationStatusResponse })
   public async rename(@Body() body: RenameFileRequest, @AuthUser() userId: number) {
      return await this.logger.errorWrapper(async () => {
         await this.storage.fileRename(userId, body.name, body.newName);
      });
   }

   @Get("info/:path")
   @ApiParam({ name: "path" })
   @ApiResponse({ type: FileInfoResponse })
   public async info(@Param("path") path: string, @AuthUser() userId: number): Promise<FileInfoResponse> {
      try {
         const info = await this.storage.fileInfo(userId, path, true, true);
         return { status: OperationStatus[OperationStatus.SUCCESS], data: info, errors: [] };
      } catch (e) {
         this.logger.logException(e);
         return { status: OperationStatus[OperationStatus.FAILED], data: null, errors: [] };
      }
   }

   @Get("exists/:path")
   @ApiParam({ name: "path" })
   @ApiResponse({ type: OpResWithData })
   public async exists(@Param("path") path: string, @AuthUser() userId: number) {
      try {
         const info = await this.storage.fileExists(userId, path);
         return { status: OperationStatus[OperationStatus.SUCCESS], data: info, errors: [] };
      } catch (e) {
         this.logger.logException(e);
         return { status: OperationStatus[OperationStatus.FAILED], data: null, errors: [] };
      }
   }

   @Get("thumbnail/:path")
   @ApiResponse({ description: "Returns a thumnail stream of the requested file" })
   @ApiParam({ name: "path", description: "File relative path + file name + extension", type: String })
   public async thumbnail(
      @Param("path") path: string,
      @AuthUser() userId: number,
      @Query("width") width: number | undefined,
      @Query("height") height: number | undefined,
   ) {
      try {
         const buffer = await this.storage.fileThumbnail(userId, path, width, height);
         if (!buffer) throw new Error("Unable to generate thumbnail for " + path);
         return new StreamableFile(Buffer.from(buffer));
      } catch (e) {
         this.logger.logException(e);
         return { status: OperationStatus[OperationStatus.FAILED], errors: [{ field: "path", message: (e as Error).message }] };
      }
   }

   @Get(":path")
   @ApiResponse({ description: "Returns a stream of the requested file" })
   @ApiParam({ name: "path", description: "File relative path + file name + extension", type: String })
   public async getFile(
      @Param("path") path: string,
      @AuthUser() userId: number,
      @Res() res: Response,
      @Req() req: Request,
   ) {
      try {
         const result = await this.storage.fileStream(userId, path, req.headers["user-agent"], undefined);
         const fileInfo = result.info;
         const fileBuffer = Buffer.from(result.buffer);

         if (fileInfo.is_video || fileInfo.is_audio) {
            const total = fileInfo.size;
            if (req.headers.range) {
               const parts = req.headers.range.replace(/bytes=/, "").split("-");
               const start = parseInt(parts[0], 10);
               const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
               const chunksize = end - start + 1;

               const rangeResult = await this.storage.fileStream(userId, path, req.headers["user-agent"], { start, end });
               res.writeHead(206, {
                  "Content-Range": "bytes " + start + "-" + end + "/" + total,
                  "Accept-Ranges": "bytes",
                  "Content-Length": chunksize,
                  "Content-Type": fileInfo.mime,
               });
               res.end(Buffer.from(rangeResult.buffer));
            } else {
               res.writeHead(200, { "Content-Length": total, "Content-Type": fileInfo.mime });
               res.end(fileBuffer);
            }
         } else {
            res.writeHead(200, { "Content-Type": fileInfo.mime, "Content-Length": fileBuffer.length });
            res.end(fileBuffer);
         }
      } catch (e) {
         this.logger.logException(e);
         res.status(400).send({
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "path", message: (e as Error).message }],
         });
      }
   }
}
