import {
   Body,
   Controller,
   Delete,
   Get,
   Param,
   Patch,
   Post,
   Query,
   Req,
   Res,
   StreamableFile,
   UnauthorizedException,
   UseGuards,
   Inject,
} from "@nestjs/common";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { Throttle } from "@nestjs/throttler";
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { OperationStatus, OperationStatusResponse } from "./../files/filesApiTypes";
import { LoggerToDb } from "./../logging";
import { TempUrl, TempUrlAccessLevel } from "./../models/tempUrl";
import { AuthUser } from "./../util";
import { TempUrlService } from "./tempUrl.service";
import {
   TempURLGenerateOptions,
   TempURLGenerateResponse,
   TempURLListResponse,
   TempURLMetaResponse,
   TempURLSaveRequest,
} from "./tempUrlApiTypes";

@Controller("temp")
@ApiTags("Temporary URLs")
export class TempUrlConstoller {
   constructor(private readonly tempUrlService: TempUrlService, @Inject() private readonly logger: LoggerToDb) {}

   @Post("generate")
   @UseGuards(JwtAuthGuard)
   // Creating share links is a low-frequency action; cap it to curb abuse / accidental loops.
   @Throttle({ default: { ttl: 60_000, limit: 20 } })
   @ApiResponse({ type: TempURLGenerateResponse })
   public async generate(
      @Req() request: Request,
      @AuthUser() userId: number,
      @Body() options: TempURLGenerateOptions,
   ): Promise<TempURLGenerateResponse> {
      try {
         return {
            url: await this.tempUrlService.generate(
               request,
               userId,
               options.filepath,
               options.max_requests,
               options.expires_at,
               options.is_readonly,
               options.access_level ?? TempUrlAccessLevel.PUBLIC,
            ),
         };
      } catch (e) {
         this.logger.logException(e as Error);
         return {
            url: "",
         };
      }
   }

   @Get(":tempUrl/meta")
   @ApiParam({ name: "tempUrl", type: String })
   @ApiResponse({ type: TempURLMetaResponse })
   public async meta(@Param("tempUrl") tempUrl: string, @Req() request: Request): Promise<TempURLMetaResponse> {
      // UnauthorizedException (authenticated_only shares) propagates as a 401 so the
      // frontend explorer knows to prompt for login.
      return await this.tempUrlService.meta(tempUrl, request.headers.cookie);
   }

   @Get(":tempUrl/list")
   @ApiParam({ name: "tempUrl", type: String })
   @ApiQuery({ name: "path", required: false, type: String })
   // Browsing is read-only and doesn't consume the download quota, but still throttle per IP.
   @Throttle({ default: { ttl: 60_000, limit: 120 } })
   @ApiResponse({ type: TempURLListResponse })
   public async list(
      @Param("tempUrl") tempUrl: string,
      @Query("path") subPath: string | undefined,
      @Req() request: Request,
   ): Promise<TempURLListResponse> {
      try {
         return await this.tempUrlService.listDir(tempUrl, subPath ?? "", request.headers.cookie);
      } catch (e) {
         if (e instanceof UnauthorizedException) throw e;
         this.logger.warn((e as Error).message);
         return {
            url: tempUrl,
            path: subPath ?? "",
            entries: [],
            errors: [{ field: "url", message: (e as Error).message }],
         };
      }
   }

   @Get(":tempUrl/thumbnail")
   @ApiParam({ name: "tempUrl", type: String })
   @ApiQuery({ name: "path", required: false, type: String })
   @ApiQuery({ name: "width", required: false, type: Number })
   @ApiQuery({ name: "height", required: false, type: Number })
   @Throttle({ default: { ttl: 60_000, limit: 300 } })
   public async thumbnail(
      @Param("tempUrl") tempUrl: string,
      @Query("path") subPath: string | undefined,
      @Query("width") width: number | undefined,
      @Query("height") height: number | undefined,
      @Req() request: Request,
   ): Promise<StreamableFile | OperationStatusResponse> {
      try {
         const stream = await this.tempUrlService.thumbnail(
            tempUrl,
            subPath ?? "",
            width,
            height,
            request.headers.cookie,
         );
         if (!stream) throw new Error("Unable to generate thumbnail for the requested file");
         return new StreamableFile(stream);
      } catch (e) {
         if (e instanceof UnauthorizedException) throw e;
         this.logger.warn((e as Error).message);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "path", message: (e as Error).message }],
         };
      }
   }

   @Get(":tempUrl/get")
   @ApiQuery({ name: "path", required: false, type: String })
   public async get(
      @Param("tempUrl") tempUrl: string,
      @Query("path") subPath: string | undefined,
      @Req() request: Request,
      @Res() res: Response,
   ) {
      try {
         const file = await this.tempUrlService.asStream(tempUrl, subPath ?? "", request.headers.cookie);
         res.set({
            "Content-Disposition": `filename="${file.filename}"`,
            "Content-Type": file.info.mime,
         });
         file.stream.pipe(res);
      } catch (e) {
         this.logger.logException(e);
         const status = e instanceof UnauthorizedException ? 401 : 200;
         res.status(status).send({
            errors: [{ field: "url", message: (e as Error).message }],
         });
      }
   }

   @Patch(":tempUrl/save")
   @ApiQuery({ name: "path", required: false, type: String })
   // Public, unauthenticated write endpoint — throttle per IP to prevent it being used as an
   // abusive write/DoS primitive while still allowing normal collaborative saves.
   @Throttle({ default: { ttl: 60_000, limit: 60 } })
   @ApiResponse({ type: OperationStatusResponse })
   public async save(
      @Param("tempUrl") tempUrl: string,
      @Query("path") subPath: string | undefined,
      @Req() request: Request,
      @Body() body: TempURLSaveRequest,
   ): Promise<OperationStatusResponse> {
      try {
         await this.tempUrlService.save(tempUrl, body.content, body.append, subPath ?? "", request.headers.cookie);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
            errors: [],
         };
      } catch (e) {
         if (e instanceof UnauthorizedException) throw e;
         this.logger.warn(e.message);
         return {
            status: OperationStatus[OperationStatus.FAILED],
            errors: [{ field: "url", message: (e as Error).message }],
         };
      }
   }

   @Get("list")
   @UseGuards(JwtAuthGuard)
   @ApiResponse({ type: [TempUrl] })
   public async listAll(@AuthUser() userId: number) {
      try {
         return await this.tempUrlService.all(userId);
      } catch (e) {
         this.logger.logException(e);
         return [];
      }
   }

   @Delete("delete/:key")
   @UseGuards(JwtAuthGuard)
   @ApiParam({ name: "key", type: String })
   @ApiResponse({ type: OperationStatusResponse })
   public async delete(@Param("key") key, @AuthUser() userId: number): Promise<OperationStatusResponse> {
      try {
         await this.tempUrlService.delete(userId, key);
         return {
            status: OperationStatus[OperationStatus.SUCCESS],
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
