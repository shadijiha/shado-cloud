import { StreamableFile } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThumbnailCacheInterceptor } from "src/files/thumbnail-cache.interceptor";
import { LoggerToDb } from "src/logging";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { REDIS_CACHE } from "src/util";
import { of } from "rxjs";
import { Readable } from "stream";

describe("ThumbnailCacheInterceptor", () => {
   let interceptor: ThumbnailCacheInterceptor;
   let mockCache: {
      getBuffer: jest.Mock;
      get: jest.Mock;
      multi: jest.Mock;
   };
   let mockFeatureFlagService: { isFeatureFlagEnabled: jest.Mock };

   beforeEach(async () => {
      mockCache = {
         getBuffer: jest.fn(),
         get: jest.fn(),
         multi: jest.fn().mockReturnValue({
            setex: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue([]),
         }),
      };

      mockFeatureFlagService = {
         isFeatureFlagEnabled: jest.fn().mockResolvedValue(false),
      };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            ThumbnailCacheInterceptor,
            { provide: REDIS_CACHE, useValue: mockCache },
            { provide: LoggerToDb, useValue: { debug: jest.fn(), error: jest.fn() } },
            { provide: FeatureFlagService, useValue: mockFeatureFlagService },
         ],
      }).compile();

      interceptor = module.get<ThumbnailCacheInterceptor>(ThumbnailCacheInterceptor);
   });

   describe("getCacheKey", () => {
      it("should generate cache key with dimensions", () => {
         const key = ThumbnailCacheInterceptor.getCacheKey(1, "test.jpg", 400, 300);
         expect(key).toBe("1:test.jpg:400:300");
      });

      it("should generate cache key without dimensions", () => {
         const key = ThumbnailCacheInterceptor.getCacheKey(1, "test.jpg", 400, 300, false);
         expect(key).toBe("1:test.jpg");
      });

      it("should handle undefined dimensions", () => {
         const key = ThumbnailCacheInterceptor.getCacheKey(1, "test.pdf", undefined, undefined);
         expect(key).toBe("1:test.pdf:undefined:undefined");
      });
   });

   describe("detectMimeFromBuffer", () => {
      it("should detect PNG from magic bytes", () => {
         const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
         const mime = (interceptor as any).detectMimeFromBuffer(pngBuffer);
         expect(mime).toBe("image/png");
      });

      it("should detect JPEG from magic bytes", () => {
         const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
         const mime = (interceptor as any).detectMimeFromBuffer(jpegBuffer);
         expect(mime).toBe("image/jpeg");
      });

      it("should detect GIF from magic bytes", () => {
         const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
         const mime = (interceptor as any).detectMimeFromBuffer(gifBuffer);
         expect(mime).toBe("image/gif");
      });

      it("should detect WebP from magic bytes", () => {
         const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
         const mime = (interceptor as any).detectMimeFromBuffer(webpBuffer);
         expect(mime).toBe("image/webp");
      });

      it("should default to image/png for unknown format", () => {
         const unknownBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
         const mime = (interceptor as any).detectMimeFromBuffer(unknownBuffer);
         expect(mime).toBe("image/png");
      });

      it("should detect PNG for PDF thumbnail (not application/pdf)", () => {
         // PDF thumbnails are converted to PNG, so the buffer should have PNG magic bytes
         const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
         const mime = (interceptor as any).detectMimeFromBuffer(pngBuffer);
         // This is the bug fix - even if the original file was a PDF, the thumbnail is PNG
         expect(mime).toBe("image/png");
         expect(mime).not.toBe("application/pdf");
      });
   });

   describe("intercept - cache hit", () => {
      it("should return cached thumbnail when cache hit", async () => {
         const cachedBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG
         mockCache.getBuffer.mockResolvedValue(cachedBuffer);
         mockCache.get.mockResolvedValue("image/png");

         const mockContext = createMockContext(1, "document.pdf", "400", undefined);
         const mockNext = { handle: jest.fn().mockReturnValue(of(null)) };

         const result = await interceptor.intercept(mockContext as any, mockNext);
         const value = await result.toPromise();

         expect(value).toBeInstanceOf(StreamableFile);
         // Cache hit should not call next handler
         expect(mockNext.handle).not.toHaveBeenCalled();
      });

      it("should not return cached data if MIME is missing", async () => {
         mockCache.getBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
         mockCache.get.mockResolvedValue(null);

         const mockContext = createMockContext(1, "test.jpg", "400", undefined);
         const mockNext = { handle: jest.fn().mockReturnValue(of({ data: "test" })) };

         await interceptor.intercept(mockContext as any, mockNext);

         expect(mockNext.handle).toHaveBeenCalled();
      });
   });

   describe("intercept - cache miss", () => {
      it("should cache thumbnail with detected MIME type from buffer", async () => {
         mockCache.getBuffer.mockResolvedValue(null);
         mockCache.get.mockResolvedValue(null);

         const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
         const mockStream = new Readable({ read() { this.push(pngBuffer); this.push(null); } });
         const streamableFile = new StreamableFile(mockStream);

         const mockContext = createMockContext(1, "document.pdf", "400", undefined);
         const mockNext = { handle: jest.fn().mockReturnValue(of(streamableFile)) };

         const mockMulti = {
            setex: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue([[null, "OK"], [null, "OK"]]),
         };
         mockCache.multi.mockReturnValue(mockMulti);

         const result = await interceptor.intercept(mockContext as any, mockNext);
         await result.toPromise();

         // Verify MIME was detected from buffer, not from file path
         expect(mockMulti.setex).toHaveBeenCalledWith(
            expect.stringContaining("_MIME"),
            expect.any(Number),
            "image/png"
         );
      });

      it("should bypass cache when feature flag is enabled", async () => {
         mockFeatureFlagService.isFeatureFlagEnabled.mockResolvedValue(true);

         const mockContext = createMockContext(1, "test.jpg", "400", undefined);
         const mockNext = { handle: jest.fn().mockReturnValue(of({ data: "test" })) };

         await interceptor.intercept(mockContext as any, mockNext);

         expect(mockCache.getBuffer).not.toHaveBeenCalled();
         expect(mockNext.handle).toHaveBeenCalled();
      });
   });

   function createMockContext(userId: number, path: string, width: string | undefined, height: string | undefined) {
      return {
         switchToHttp: () => ({
            getRequest: () => ({
               params: { path },
               query: { width, height },
               cookies: { shado_cloud: createMockJwt(userId) },
               path: `/file/thumbnail/${path}`,
            }),
            getResponse: () => ({
               setHeader: jest.fn(),
            }),
         }),
      };
   }

   function createMockJwt(userId: number): string {
      const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");
      const payload = Buffer.from(JSON.stringify({ userId })).toString("base64");
      return `${header}.${payload}.signature`;
   }
});
