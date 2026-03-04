import {
   Body,
   Controller,
   Delete,
   Get,
   Param,
   Patch,
   Post,
   Res,
   UseGuards,
   Headers,
   Inject,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { OperationStatus, OperationStatusResponse } from "./../files/filesApiTypes";
import { LoggerToDb } from "./../logging";
import { TempUrl } from "./../models/tempUrl";
import { AuthUser } from "./../util";
import { TempURLGenerateOptions, TempURLGenerateResponse, TempURLSaveRequest } from "./tempUrlApiTypes";
import { IncomingHttpHeaders } from "http";
import { StorageClient } from "../storage/storage.client";

@Controller("temp")
@ApiTags("Temporary URLs")
export class TempUrlConstoller {
   constructor(
      private readonly storage: StorageClient,
      @Inject() private readonly logger: LoggerToDb,
   ) {}

   @Post("generate")
   @UseGuards(AuthGuard("jwt"))
   @ApiResponse({ type: TempURLGenerateResponse })
   public async generate(
      @Headers() headers: IncomingHttpHeaders,
      @AuthUser() userId: number,
      @Body() options: TempURLGenerateOptions,
   ): Promise<TempURLGenerateResponse> {
      try {
         return {
            url: await this.storage.tempGenerate(
               headers, userId, options.filepath,
               options.max_requests, options.expires_at, options.is_readonly,
            ),
         };
      } catch (e) {
         this.logger.logException(e);
         return { url: "" };
      }
   }

   @Get(":tempUrl/get")
   public async get(@Param("tempUrl") tempUrl: string, @Res() res: Response) {
      try {
         const result = await this.storage.tempStream(tempUrl);
         res.set({ "Content-Disposition": `filename="${result.filename}"`, "Content-Type": result.info.mime });
         res.end(Buffer.from(result.buffer));
      } catch (e) {
         this.logger.logException(e);
         res.send({ errors: [{ field: "url", message: (e as Error).message }] });
      }
   }

   @Patch(":tempUrl/save")
   @ApiResponse({ type: OperationStatusResponse })
   public async save(
      @Param("tempUrl") tempUrl: string,
      @Body() body: TempURLSaveRequest,
   ): Promise<OperationStatusResponse> {
      try {
         await this.storage.tempSave(tempUrl, body.content, body.append);
         return { status: OperationStatus[OperationStatus.SUCCESS], errors: [] };
      } catch (e) {
         this.logger.warn(e.message);
         return { status: OperationStatus[OperationStatus.FAILED], errors: [{ field: "url", message: (e as Error).message }] };
      }
   }

   @Get("list")
   @UseGuards(AuthGuard("jwt"))
   @ApiResponse({ type: [TempUrl] })
   public async list(@AuthUser() userId: number) {
      try {
         return await this.storage.tempList(userId);
      } catch (e) {
         this.logger.logException(e);
         return [];
      }
   }

   @Delete("delete/:key")
   @UseGuards(AuthGuard("jwt"))
   @ApiParam({ name: "key", type: String })
   @ApiResponse({ type: OperationStatusResponse })
   public async delete(@Param("key") key, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      try {
         await this.storage.tempDelete(userId, key);
         return { status: OperationStatus[OperationStatus.SUCCESS], errors: [] };
      } catch (e) {
         this.logger.logException(e);
         return { status: OperationStatus[OperationStatus.FAILED], errors: [{ field: "", message: (e as Error).message }] };
      }
   }
}
