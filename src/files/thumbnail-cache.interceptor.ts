import { CACHE_MANAGER, CacheInterceptor } from '@nestjs/cache-manager';
import { Injectable, ExecutionContext, CallHandler, Inject, Logger, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Cache } from 'cache-manager';
import { Observable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { getUserIdFromRequest } from 'src/util';
import { FilesService } from './files.service';

/**
 * This interceptor is made to cache the requests thumbnails 
 * if a path exists in cache it will be returned and requests will be short circuited
 * if it doesn't, then request will proceed and then we'll cache the file in the response 
 */
@Injectable()
export class ThumbnailCacheInterceptor extends CacheInterceptor {

    private static CachedFileTTL = 1000 * 60 * 5; // 5 minutes TTL for cached thumbnails

    private readonly logger = new Logger(ThumbnailCacheInterceptor.name);

    constructor(
        @Inject(CACHE_MANAGER) private cache: Cache,
        reflector: Reflector,
    ) {
        super(cache, reflector);
    }

    // TODOOOO: We might run into an issue where since only UploadedFile tumbnails in DB are invalidated with
    // a file is changed/delete and since here we are caching ALL files regardless of if they are in UploadedFile table
    // We can run into this situation:
    //  - We have a file that is not registered in UploadedFile ---> Then cached here ---> Then changed/delete
    //    ---> therefor its cache is not invalidated it since it is not a UploadedFile
    public async intercept(context: ExecutionContext, next: CallHandler<any>): Promise<Observable<any>> {
        const request: Request = context.switchToHttp().getRequest();
        const response: Response = context.switchToHttp().getResponse();
        const cacheKey = this.getCacheKeyFromReq(request);

        // Check if the thumbnail is cached
        const cachedThumbnail: { type: "Buffer", data: Array<number> } = await this.cache.get(cacheKey);
        const cachedMime = await this.cache.get<string>(`${cacheKey}_MIME`);
        if (cachedThumbnail && cachedMime) {
            this.logger.debug(`Cache hit for ${cacheKey} ${cachedMime}`);

            // Send the cached thumbnail
            response.setHeader('Content-Type', cachedMime); // Adjust MIME type

            const buffer = Buffer.from(cachedThumbnail.data);
            return of(new StreamableFile(buffer)); // Short-circuit the request to avoid further processing
        }

        // Proceed with the original request and cache the result afterward
        return next.handle().pipe(
            switchMap(async (data) => {

                // If the data is a stream, intercept the stream and cache it
                if (data instanceof StreamableFile) {
                    this.logger.debug(`Received stream data for thumbnail`);

                    const fileBuffer = await this.streamToBuffer(data);

                    // Cache the thumbnail
                    const { path: filepath } = request;
                    await this.cache.set(cacheKey, fileBuffer, ThumbnailCacheInterceptor.CachedFileTTL);
                    await this.cache.set(`${cacheKey}_MIME`, FilesService.detectFile(filepath));

                    this.logger.debug(`Caching thumbnail for ${cacheKey}`);

                    // Send the file to the response
                    //response.setHeader('Content-Type', 'image/jpeg'); // Adjust MIME type as needed

                    return new StreamableFile(fileBuffer); // No need to proceed further since we already sent the response
                }

                // If data is not a stream, just return it as is
                return data;
            })
        );
    }

    private getCacheKeyFromReq(request: Request): string {
        const userId = getUserIdFromRequest(request);
        const { params, query } = request;
        const { path } = params;
        const { width, height } = query;
        return ThumbnailCacheInterceptor.getCacheKey(userId, path, width, height);
    }

    public static getCacheKey(userId: number, path: string, width?: any, height?: any, includeDimensions: boolean = true): string {
        if (includeDimensions)
            return `${userId}:${path}:${width}:${height}`;
        else
            return `${userId}:${path}`;
    }

    // This method reads the StreamableFile stream and returns the file as a Buffer
    private async streamToBuffer(streamableFile: StreamableFile): Promise<Buffer> {
        const stream = streamableFile.getStream();

        return new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];

            stream.on('data', (chunk) => {
                chunks.push(chunk);
            });

            stream.on('end', () => {
                resolve(Buffer.concat(chunks)); // Concatenate all chunks into a single buffer
            });

            stream.on('error', (err) => {
                reject(err); // Reject with error if stream fails
            });
        });
    }
}
