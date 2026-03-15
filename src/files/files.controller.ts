import {
   Body,
   Controller,
   Delete,
   Get,
   Inject,
   Logger,
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
import { JwtAuthGuard } from "src/auth/auth.guard";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { LoggerToDb } from "./../logging";
import { ApiFile, AuthUser } from "src/util";
import { FilesService } from "./files.service";
import {
   FileInfoResponse,
   NewFileRequest,
   OperationStatus,
   OperationStatusResponse,
   OpResWithData,
   RenameFileRequest,
   SaveFileRequest,
} from "./filesApiTypes";
import { ThumbnailCacheInterceptor } from "./thumbnail-cache.interceptor";

@Controller("file")
@UseGuards(JwtAuthGuard)
@ApiTags("Files")
export class FilesConstoller {
   constructor(private readonly fileService: FilesService, @Inject() private readonly logger: LoggerToDb) {}

   @Get("profile-picture-info")
   @ApiResponse({ description: "Returns profile picture metadata for the authenticated user" })
   public async profilePictureInfo(@AuthUser() userId: number) {
      return this.fileService.profilePictureInfo(userId);
   }

   @Post("upload")
   @ApiOperation({ summary: "Upload a file", description: "Upload a single file. For files larger than 100MB behind a Cloudflare Tunnel, use the chunked upload endpoints instead as Cloudflare's free plan rejects request bodies exceeding 100MB." })
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
         await this.fileService.upload(userId, file, body.dest);
      });
   }

   @Post("upload/chunked/init")
   @ApiOperation({ summary: "Initialize a chunked upload", description: "Starts a chunked upload session. Use this for large files (>100MB) that would be rejected by Cloudflare Tunnel's request body size limit. Returns an uploadId to use for subsequent chunk uploads." })
   @ApiResponse({ type: OperationStatusResponse })
   public async chunkedUploadInit(
      @AuthUser() userId: number,
      @Body() body: { dest: string; filename: string; totalSize: number },
   ) {
      return await this.logger.errorWrapper(async () => {
         return await this.fileService.chunkedUploadInit(userId, body.dest, body.filename, body.totalSize);
      });
   }

   @Post("upload/chunked/:uploadId")
   @ApiOperation({ summary: "Upload a chunk", description: "Uploads a single chunk of a file. Each chunk must be under 100MB to pass through Cloudflare Tunnel. Chunks are identified by index and reassembled on completion." })
   @ApiParam({ name: "uploadId", description: "Upload session ID returned by the init endpoint" })
   @ApiResponse({ type: OperationStatusResponse })
   @ApiConsumes("multipart/form-data")
   @ApiFile()
   @UseInterceptors(FileInterceptor("file"))
   public async chunkedUploadPart(
      @AuthUser() userId: number,
      @UploadedFile() file: Express.Multer.File,
      @Param("uploadId") uploadId: string,
      @Body() body: { index: string },
   ) {
      return await this.logger.errorWrapper(async () => {
         await this.fileService.chunkedUploadPart(userId, uploadId, parseInt(body.index), file);
      });
   }

   @Post("upload/chunked/:uploadId/complete")
   @ApiOperation({ summary: "Complete a chunked upload", description: "Assembles all uploaded chunks into the final file and saves it. Must be called after all chunks have been uploaded." })
   @ApiParam({ name: "uploadId", description: "Upload session ID returned by the init endpoint" })
   @ApiResponse({ type: OperationStatusResponse })
   public async chunkedUploadComplete(
      @AuthUser() userId: number,
      @Param("uploadId") uploadId: string,
   ) {
      return await this.logger.errorWrapper(async () => {
         await this.fileService.chunkedUploadComplete(userId, uploadId);
      });
   }

   @Post("new")
   @ApiResponse({ type: OperationStatusResponse })
   public async new(@Body() body: NewFileRequest, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      return await this.logger.errorWrapper(async () => {
         await this.fileService.new(userId, body.name);
      });
   }

   @Patch("save")
   @ApiResponse({ type: OperationStatusResponse })
   public async save(@Body() body: SaveFileRequest, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      const [success, message] = await this.fileService.save(userId, body.name, body.content, body.append);
      if (success) {
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            errors: [],
         };
      } else {
         this.logger.logException(new Error(message));
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message }],
         };
      }
   }

   @Delete("delete")
   @ApiResponse({ type: OperationStatusResponse })
   public async delete(@Body() body: NewFileRequest, @AuthUser() userId: number) {
      const [success, message] = await this.fileService.delete(userId, body.name);
      if (success) {
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            errors: [],
         };
      } else {
         this.logger.logException(new Error(message));
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message }],
         };
      }
   }

   @Patch("rename")
   @ApiResponse({ type: OperationStatusResponse })
   public async rename(@Body() body: RenameFileRequest, @AuthUser() userId: number) {
      return await this.logger.errorWrapper(async () => {
         await this.fileService.rename(userId, body.name, body.newName);
      });
   }

   @Get("info/:path")
   @ApiParam({ name: "path" })
   @ApiResponse({ type: FileInfoResponse })
   public async info(@Param("path") path: string, @AuthUser() userId: number): Promise<FileInfoResponse> {
      try {
         const info = await this.fileService.info(userId, path, true, true);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            data: info,
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            data: null,
            errors: [],
         };
      }
   }

   @Get("exists/:path")
   @ApiParam({ name: "path" })
   @ApiResponse({ type: OpResWithData })
   public async exists(@Param("path") path: string, @AuthUser() userId: number) {
      try {
         const info = await this.fileService.exists(userId, path);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            data: info,
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            data: null,
            errors: [],
         };
      }
   }

   @Get("thumbnail/:path")
   @UseInterceptors(ThumbnailCacheInterceptor)
   @ApiResponse({
      description: "Returns a thumnail stream of the requested file",
   })
   @ApiParam({
      name: "path",
      description: "File relative path + file name + extension",
      type: String,
   })
   public async thumbnail(
      @Param("path") path: string,
      @AuthUser() userId: number,
      @Query("width") width: number | undefined,
      @Query("height") height: number | undefined,
   ) {
      try {
         const stream = await this.fileService.toThumbnail(path, userId, width, height);
         if (!stream) {
            throw new Error("Unable to generate thumbnail for " + path);
         }

         return new StreamableFile(stream);
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "path", message: (e as Error).message }],
         };
      }
   }

   @Get(":path")
   @ApiResponse({ description: "Returns a stream of the requested file" })
   @ApiParam({
      name: "path",
      description: "File relative path + file name + extension",
      type: String,
   })
   public async getFile(
      @Param("path") path: string,
      @AuthUser() userId: number,
      @Res() res: Response,
      @Req() req: Request,
   ) {
      try {
         const fileInto = await this.fileService.info(userId, path, false, false);

         // In case that it is a video or audio
         // We need to see if this request is for seeking
         if (fileInto.is_video || fileInto.is_audio) {
            const total = fileInto.size;
            if (req.headers.range) {
               const range = req.headers.range;
               const parts = range.replace(/bytes=/, "").split("-");
               const partialstart = parts[0];
               const partialend = parts[1];

               const start = parseInt(partialstart, 10);
               const end = partialend ? parseInt(partialend, 10) : total - 1;
               const chunksize = end - start + 1;

               const file = await this.fileService.asStream(userId, path, req.headers["user-agent"], {
                  start,
                  end,
               });
               res.writeHead(206, {
                  "Content-Range": "bytes " + start + "-" + end + "/" + total,
                  "Accept-Ranges": "bytes",
                  "Content-Length": chunksize,
                  "Content-Type": fileInto.mime,
               });

               file.pipe(res);
            } else {
               res.writeHead(200, {
                  "Content-Length": total,
                  "Content-Type": fileInto.mime,
               });
               (await this.fileService.asStream(userId, path, req.headers["user-agent"])).pipe(res);
            }
         }
         // Otherwise for any other file just do a simple stream
         else {
            const file = await this.fileService.asStream(userId, path, req.headers["user-agent"]);
            res.writeHead(200, {
               "Content-Type": fileInto.mime,
               "Content-Length": fileInto.size,
            });
            file.pipe(res);
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
