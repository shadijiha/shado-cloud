import {
   Body,
   Controller,
   Get,
   Param,
   Post,
   UploadedFile,
   UseGuards,
   UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { FilesService } from "../files/files.service";
import { DirectoriesService } from "../directories/directories.service";
import { ServiceKeyGuard } from "../auth/service-key.guard";

@Controller("internal")
@UseGuards(ServiceKeyGuard)
export class InternalController {
   constructor(
      private readonly fileService: FilesService,
      private readonly dirService: DirectoriesService,
   ) {}

   @Post("file/upload")
   @UseInterceptors(FileInterceptor("file"))
   async upload(@UploadedFile() file: Express.Multer.File, @Body() body: { dest: string; userId: string }) {
      const [success, message] = await this.fileService.upload(body.userId, file, body.dest);
      return { success, message };
   }

   @Post("directory/ensure")
   async ensureDir(@Body() body: { userId: string; path: string }) {
      try {
         const exists = await this.fileService.exists(body.userId, body.path);
         if (!exists) {
            await this.dirService.new(body.userId, body.path);
         }
         return { success: true };
      } catch {
         return { success: true };
      }
   }

   @Get("file/exists/:userId/:path")
   async exists(@Param("userId") userId: string, @Param("path") filePath: string) {
      return { exists: await this.fileService.exists(userId, filePath) };
   }

   @Get("file/info/:userId/:path")
   async fileInfo(@Param("userId") userId: string, @Param("path") filePath: string) {
      try {
         const info = await this.fileService.info(userId, filePath);
         return { success: true, size: info.size, mime: info.mime };
      } catch {
         return { success: false };
      }
   }

   @Get("file/absolute-path/:userId/:path")
   async absolutePath(@Param("userId") userId: string, @Param("path") filePath: string) {
      try {
         const abs = await this.fileService.absolutePath(userId, filePath);
         return { success: true, path: abs };
      } catch {
         return { success: false };
      }
   }
}
