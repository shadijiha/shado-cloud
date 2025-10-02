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
   UseGuards,
   ValidationPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { OperationStatus, OperationStatusResponse } from "./../files/filesApiTypes";
import { LoggerToDb } from "./../logging";
import { UploadedFile } from "./../models/uploadedFile";
import { AuthUser } from "./../util";
import { DirectoriesService } from "./directories.service";
import { DirListResponse, NewDirRequest, RenameDirRequest } from "./directoriesApiTypes";

@Controller("directory")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Directories")
export class DirectoriesController {
   constructor(
      private readonly directoriesService: DirectoriesService,
      @Inject() private readonly logger: LoggerToDb,
   ) {}

   @Get("root")
   public async root(@AuthUser() userId: number) {
      try {
         return {
            rootDir: await this.directoriesService.root(userId),
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            rootDir: "",
         };
      }
   }

   @Get("list{/:path}")
   @ApiParam({ name: "path", type: String, required: false, allowEmptyValue: true })
   @ApiResponse({ type: DirListResponse })
   public async list(@AuthUser() userId: number, @Param("path") path: string | undefined): Promise<DirListResponse> {
      try {
         const list = await this.directoriesService.list(userId, path ?? "");

         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            parent: this.directoriesService.parent(path),
            data: list,
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            data: null,
            parent: null,
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   @Get("listrecursive")
   @ApiResponse({ type: [String] })
   public async listrecursive(
      @AuthUser() userId: number,
      @Query("showHidden", new ValidationPipe({ transform: true })) showHidden: boolean,
   ) {
      try {
         return await this.directoriesService.listrecursive(userId, showHidden);
      } catch (e) {
         this.logger.logException(e);
         return [];
      }
   }

   @Post("new")
   @ApiResponse({ type: OperationStatusResponse })
   public async new(@AuthUser() userId: number, @Body() body: NewDirRequest): Promise<OperationStatusResponse> {
      try {
         await this.directoriesService.new(userId, body.name);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "path", message: (e as Error).message }],
         };
      }
   }

   @Delete("delete")
   @ApiResponse({ type: OperationStatusResponse })
   public async delete(@AuthUser() userId: number, @Body() body: NewDirRequest) {
      try {
         await this.directoriesService.delete(userId, body.name);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   @Patch("rename")
   @ApiResponse({ type: OperationStatusResponse })
   public async rename(@AuthUser() userId: number, @Body() body: RenameDirRequest) {
      try {
         await this.directoriesService.rename(userId, body.name, body.newName);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   @Get("search")
   @ApiQuery({ name: "val" })
   @ApiResponse({ type: [UploadedFile] })
   public async search(@AuthUser() userId: number, @Query("val") searchText: string) {
      try {
         return await this.directoriesService.search(userId, searchText);
      } catch (e) {
         this.logger.logException(e);
         return [];
      }
   }

   @Patch("zip")
   @ApiResponse({ type: OperationStatusResponse })
   public zip(@AuthUser() userId: number, @Body() body: NewDirRequest): OperationStatusResponse {
      try {
         this.directoriesService.zip(userId, body.name).catch((e) => {
            this.logger.logException(e);
         });
         return {
            status: OperationStatus[OperationStatus.ONGOING],
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }

   @Patch("unzip")
   @ApiResponse({ type: OperationStatusResponse })
   public unzip(@AuthUser() userId: number, @Body() body: NewDirRequest) {
      try {
         this.directoriesService.unzip(userId, body.name).catch((e) => {
            this.logger.logException(e);
         });

         return {
            status: OperationStatus[OperationStatus.ONGOING],
            errors: [],
         };
      } catch (e) {
         this.logger.logException(e);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "", message: (e as Error).message }],
         };
      }
   }
}
