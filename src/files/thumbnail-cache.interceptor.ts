import {
   Injectable,
   type ExecutionContext,
   type CallHandler,
   Inject,
   StreamableFile,
   NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Observable, of } from "rxjs";
import { switchMap } from "rxjs/operators";
import { type Request, type Response } from "express";
import { getUserIdFromRequest, REDIS_CACHE } from "src/util";
import { FilesService } from "./files.service";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { LoggerToDb } from "src/logging";
import type Redis from "ioredis";

/**
 * This interceptor is made to cache the requests thumbnails
 * if a path exists in cache it will be returned and requests will be short circuited
 * if it doesn't, then request will proceed and then we'll cache the file in the response
 */
@Injectable()
export class ThumbnailCacheInterceptor implements NestInterceptor {
   private static readonly CachedFileTTLSeconds = 60 * 60 * 24 * 30; // 30 days TTL for cached thumbnails

   constructor(@Inject(REDIS_CACHE) private readonly cache: Redis, private readonly logger: LoggerToDb) {}

   // TODOOOO: We might run into an issue where since only UploadedFile tumbnails in DB are invalidated with
   // a file is changed/delete and since here we are caching ALL files regardless of if they are in UploadedFile table
   // We can run into this situation:
   //  - We have a file that is not registered in UploadedFile ---> Then cached here ---> Then changed/delete
   //    ---> therefor its cache is not invalidated it since it is not a UploadedFile
   public async intercept(context: ExecutionContext, next: CallHandler<any>): Promise<Observable<any>> {
      const request: Request & { configService: ConfigService<EnvVariables> } = context.switchToHttp().getRequest();
      const response: Response = context.switchToHttp().getResponse();
      const cacheKey = this.getCacheKeyFromReq(request);

      // Check if the thumbnail is cached
      const cachedThumbnail = await this.cache.getBuffer(cacheKey);
      const cachedMime = await this.cache.get(`${cacheKey}_MIME`);
      if (cachedThumbnail && cachedMime) {
         this.logger.debug(`Cache hit for ${cacheKey} ${cachedMime}`);

         // Send the cached thumbnail
         response.setHeader("Content-Type", cachedMime); // Adjust MIME type

         return of(new StreamableFile(cachedThumbnail)); // Short-circuit the request to avoid further processing
      }

      // Proceed with the original request and cache the result afterward
      return next.handle().pipe(
         switchMap(async (data) => {
            // If the data is a stream, intercept the stream and cache it
            if (data instanceof StreamableFile) {
               this.logger.debug("Received stream data for thumbnail");

               const fileBuffer = await this.streamToBuffer(data);

               // Cache the thumbnail
               const { path: filepath } = request;

               const cacheMultiExecResult = await this.cache
                  .multi()
                  .setex(cacheKey, ThumbnailCacheInterceptor.CachedFileTTLSeconds, fileBuffer)
                  .setex(
                     `${cacheKey}_MIME`,
                     ThumbnailCacheInterceptor.CachedFileTTLSeconds,
                     FilesService.detectFile(filepath),
                  )
                  .exec();
               cacheMultiExecResult.forEach(([err, result]) => {
                  if (err) {
                     this.logger.error(`Error caching thumbnail for ${cacheKey}: ${err}`);
                  }
               });

               this.logger.debug(`Caching thumbnail for ${cacheKey}`);

               // Send the file to the response
               // response.setHeader('Content-Type', 'image/jpeg'); // Adjust MIME type as needed

               return new StreamableFile(fileBuffer); // No need to proceed further since we already sent the response
            }

            // If data is not a stream, just return it as is
            return data;
         }),
      );
   }

   private getCacheKeyFromReq(request: Request & { configService: ConfigService<EnvVariables> }): string {
      const userId = getUserIdFromRequest(request);
      const { params, query } = request;
      const { path } = params;
      const { width, height } = query;
      return ThumbnailCacheInterceptor.getCacheKey(userId, path, width, height);
   }

   public static getCacheKey(
      userId: number,
      path: string,
      width?: any,
      height?: any,
      includeDimensions = true,
   ): string {
      if (includeDimensions) return `${userId}:${path}:${width}:${height}`;
      else return `${userId}:${path}`;
   }

   // This method reads the StreamableFile stream and returns the file as a Buffer
   private async streamToBuffer(streamableFile: StreamableFile): Promise<Buffer> {
      const stream = streamableFile.getStream();

      return await new Promise<Buffer>((resolve, reject) => {
         const chunks: Buffer[] = [];

         stream.on("data", (chunk) => {
            chunks.push(chunk);
         });

         stream.on("end", () => {
            resolve(Buffer.concat(chunks)); // Concatenate all chunks into a single buffer
         });

         stream.on("error", (err) => {
            reject(err); // Reject with error if stream fails
         });
      });
   }
}
