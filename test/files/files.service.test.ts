import { Test, type TestingModule } from "@nestjs/testing";
import { FilesService } from "src/files/files.service"; // Replace with your actual service path
import ThumbnailGenerator from "fs-thumbnail";
import sharp from "sharp";
import { type Repository } from "typeorm";
import { UploadedFile } from "src/models/uploadedFile";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "src/auth/auth.service";
import { SearchStat } from "src/models/stats/searchStat";
import { FileAccessStat } from "src/models/stats/fileAccessStat";
import { TempUrl } from "src/models/tempUrl";
import { LoggerToDb } from "src/logging";
import { type User } from "src/models/user";
import type Redis from "ioredis";
import { ThumbnailCacheInterceptor } from "src/files/thumbnail-cache.interceptor";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { REDIS_CACHE } from "src/util";

// Mocking external dependencies
jest.mock("sharp", () => {
   return jest.fn().mockImplementation(() => {
      return {
         resize: jest.fn().mockReturnThis(),
         toBuffer: jest.fn().mockResolvedValue(Buffer.from("mocked image data")),
         withMetadata: jest.fn().mockReturnThis(),
         pipe: jest.fn().mockReturnValue({
            toFile: jest.fn().mockResolvedValue({}),
         }),
      };
   });
});
jest.mock("fs-thumbnail");

// Mocking the Date function to return a fixed date
const mockDate = new Date("2024-12-15");
jest.useFakeTimers().setSystemTime(mockDate);

describe("FilesService", () => {
   let service: FilesService;
   let uploadedFileRepo: Repository<UploadedFile>;
   let fileAccessStatRepo: Repository<FileAccessStat>;
   let userService: AuthService;
   let logger: LoggerToDb;
   let cache: Redis;
   let fs: AbstractFileSystem;
   let config: ConfigService<Pick<EnvVariables, "CLOUD_DIR">>;

   beforeEach(async () => {
      sharp.cache = jest.fn();
      sharp.simd = jest.fn();

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            FilesService,
            {
               provide: getRepositoryToken(UploadedFile),
               useValue: {
                  findOne: jest.fn(),
                  save: jest.fn(),
                  createQueryBuilder: jest.fn(),
               },
            },
            {
               provide: getRepositoryToken(SearchStat),
               useValue: {
                  findOne: jest.fn(),
                  save: jest.fn(),
                  createQueryBuilder: jest.fn(),
               },
            },
            {
               provide: getRepositoryToken(FileAccessStat),
               useValue: {
                  findOne: jest.fn(),
                  save: jest.fn(),
                  createQueryBuilder: jest.fn(),
               },
            },
            {
               provide: getRepositoryToken(TempUrl),
               useValue: {
                  findOne: jest.fn(),
                  save: jest.fn(),
                  createQueryBuilder: jest.fn(),
               },
            },
            {
               provide: LoggerToDb,
               useValue: {
                  logException: jest.fn(),
                  log: jest.fn(),
                  error: jest.fn(),
                  debug: jest.fn(),
               },
            },
            {
               provide: AuthService,
               useValue: {},
            },
            {
               provide: REDIS_CACHE,
               useValue: {
                  scan: jest.fn().mockReturnValue(["0", []]),
               },
            },
            {
               provide: AbstractFileSystem,
               useValue: {
                  writeFileSync: jest.fn(),
                  existsSync: jest.fn(),
                  mkdirSync: jest.fn(),
                  unlinkSync: jest.fn(),
               },
            },
            {
               provide: ConfigService,
               useValue: {
                  get: jest
                     .fn()
                     .mockImplementation((key: string) => (key == "CLOUD_DIR" ? "/testing_cloud" : undefined)),
               },
            },
         ],
      }).compile();

      service = module.get<FilesService>(FilesService);
      userService = module.get<AuthService>(AuthService);
      uploadedFileRepo = module.get<Repository<UploadedFile>>(getRepositoryToken(UploadedFile));
      fileAccessStatRepo = module.get<Repository<FileAccessStat>>(getRepositoryToken(FileAccessStat));
      logger = module.get<LoggerToDb>(LoggerToDb);
      cache = module.get<Redis>(REDIS_CACHE) as any;
      fs = module.get<AbstractFileSystem>(AbstractFileSystem);
      config = module.get<ConfigService>(ConfigService);
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe("upload", () => {
      let mockFsWriteFileSync;
      const mockFile = {
         fieldname: "file",
         originalname: "test.txt",
         encoding: "7bit",
         mimetype: "text/plain",
         buffer: Buffer.from("Test file content"),
         size: 1024, // 1KB
      } as Express.Multer.File;

      beforeEach(async () => {
         mockFsWriteFileSync = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});
      });

      it("should successfully upload a file if space is available and permissions are granted", async () => {
         // Arrange
         const userId = 1;
         const dest = "/uploads";
         const usedData = { total: jest.fn().mockReturnValue(1024) }; // 1KB used
         const user = { getMaxData: jest.fn().mockResolvedValue(2048) }; // 2KB max space

         // Mock external service methods
         userService.getById = jest.fn().mockResolvedValue(user);
         service.getUsedData = jest.fn().mockResolvedValue(usedData);
         service.getUserRootPath = jest.fn().mockResolvedValue("/root");
         service.absolutePath = jest.fn().mockResolvedValue("/root/uploads/test.txt");
         service.isOwner = jest.fn().mockResolvedValue(true);

         // Mock DB response for no existing file
         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(null);

         // Act
         const result = await service.upload(userId, mockFile, dest);

         // Assert
         expect(result).toEqual([true, ""]);
         expect(mockFsWriteFileSync).toHaveBeenCalledWith("/root/uploads/test.txt", mockFile.buffer);
         expect(uploadedFileRepo.save).toHaveBeenCalled();
      });

      it("should return error if the user does not have enough space", async () => {
         // Arrange
         const userId = 1;
         const dest = "/uploads";
         const usedData = { total: jest.fn().mockReturnValue(1024) }; // 1KB used
         const user = { getMaxData: jest.fn().mockResolvedValue(1024) }; // 1KB max space

         userService.getById = jest.fn().mockResolvedValue(user);
         service.getUsedData = jest.fn().mockResolvedValue(usedData);

         // Act
         const result = await service.upload(userId, mockFile, dest);

         // Assert
         expect(result).toEqual([false, "You don't have enough space to upload this file"]);
      });

      it("should return error if the user does not have permission to upload to the specified location", async () => {
         // Arrange
         const userId = 1;
         const dest = "/uploads";
         const usedData = { total: jest.fn().mockReturnValue(1024) }; // 1KB used
         const user = { getMaxData: jest.fn().mockResolvedValue(2048) }; // 2KB max space

         userService.getById = jest.fn().mockResolvedValue(user);
         service.getUsedData = jest.fn().mockResolvedValue(usedData);
         service.getUserRootPath = jest.fn().mockResolvedValue("/root");
         service.absolutePath = jest.fn().mockResolvedValue("/root/uploads/test.txt");
         service.isOwner = jest.fn().mockResolvedValue(false); // User doesn't own the directory

         // Act
         const result = await service.upload(userId, mockFile, dest);

         // Assert
         expect(result).toEqual([false, "You don't have permission to upload here"]);
      });

      it("should handle file replacement and invalidate thumbnails if file exists", async () => {
         // Arrange
         const user = { id: 1, email: "cait@queen.com", getMaxData: jest.fn().mockResolvedValue(2048) };
         const dest = "/uploads";
         const usedData = { total: jest.fn().mockReturnValue(1024) }; // 1KB used

         const existingFile = { id: 420, absolute_path: "uploads/test.txt", user: { id: 1 } };

         userService.getById = jest.fn().mockResolvedValue(user);
         service.getUsedData = jest.fn().mockResolvedValue(usedData);
         service.getUserRootPath = jest.fn().mockResolvedValue(`${config.get("CLOUD_DIR")}/${user.email}`);
         service.isOwner = jest.fn().mockResolvedValue(true);
         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(existingFile); // File already exists

         // Mock invalidateThumbnailsFor method
         fs.unlinkSync = jest.fn();
         fs.readdirSync = jest.fn().mockReturnValue([
            { name: `${existingFile.id}_100x120.jpg` },
            { name: `${existingFile.id}_100xundefined.jpg` },
            { name: "24_100x100.jpg" }, // <--- Shouldn't be deleted!!
         ]); // <--- this function is called by invalidateThumbnailsFor

         // Mock redis cache
         cache.scan = jest
            .fn()
            .mockReturnValue([
               "0",
               [
                  ThumbnailCacheInterceptor.getCacheKey(user.id, existingFile.absolute_path),
                  ThumbnailCacheInterceptor.getCacheKey(user.id, existingFile.absolute_path) + "_MIME",
               ],
            ]);
         cache.del = jest.fn();

         // Act
         const result = await service.upload(user.id, mockFile, dest);

         // Assert
         expect(result).toEqual([true, ""]);

         // thumbnail delation
         const thumbailAbsolute = (path: string) =>
            `${config.get("CLOUD_DIR")}/${user.email}/${FilesService.METADATA_FOLDER_NAME}/${
               FilesService.THUMBNAILS_FOLDER_NAME
            }/${path}`;
         expect(fs.unlinkSync).toHaveBeenCalledWith(thumbailAbsolute(`${existingFile.id}_100x120.jpg`));
         expect(fs.unlinkSync).toHaveBeenCalledWith(thumbailAbsolute(`${existingFile.id}_100xundefined.jpg`));
         expect(fs.unlinkSync).not.toHaveBeenCalledWith(thumbailAbsolute("24_100x100.jpg"));

         // Redis clear
         expect(cache.del).toHaveBeenCalledWith(
            ThumbnailCacheInterceptor.getCacheKey(user.id, existingFile.absolute_path),
            ThumbnailCacheInterceptor.getCacheKey(user.id, existingFile.absolute_path) + "_MIME",
         );
      });

      it("should handle errors correctly", async () => {
         // Arrange
         const userId = 1;
         const dest = "/uploads";
         const usedData = { total: jest.fn().mockReturnValue(1024) }; // 1KB used
         const user = { getMaxData: jest.fn().mockResolvedValue(2048) }; // 2KB max space

         userService.getById = jest.fn().mockResolvedValue(user);
         service.getUsedData = jest.fn().mockResolvedValue(usedData);
         service.getUserRootPath = jest.fn().mockResolvedValue("/root");
         service.absolutePath = jest.fn().mockResolvedValue("/root/uploads/test.txt");
         service.isOwner = jest.fn().mockResolvedValue(true);

         // Simulate an error during the file upload
         jest.spyOn(service, "getUsedData").mockRejectedValue(new Error("Unexpected error"));

         // Act
         const result = await service.upload(userId, mockFile, dest);

         // Assert
         expect(result).toEqual([false, "Unexpected error"]);
      });
   });

   describe("delete", () => {
      it("should return an error if the user does not have permission to delete the file", async () => {
         userService.getById = jest.fn().mockResolvedValue({ id: 1, email: "cait@queen.com" });
         service.isOwner = jest.fn().mockResolvedValue(false);

         const result = await service.delete(1, "path/to/file");
         expect(result).toEqual([false, "You don't have permission to delete this file"]);
      });

      it("should delete the file if the user is the owner", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/path/to/file`;
         const relativePath = "path/to/file";

         userService.getById = jest.fn().mockResolvedValue(user);
         service.isOwner = jest.fn().mockResolvedValue(true);
         service.absolutePath = jest.fn().mockResolvedValue(absolutePath);
         service.getUserRootPath = jest.fn().mockResolvedValue(`${config.get("CLOUD_DIR")}/${user.email}`);

         uploadedFileRepo.findOne = jest.fn().mockResolvedValue({ id: 1, absolute_path: relativePath });
         fileAccessStatRepo.find = jest.fn().mockResolvedValue([]);
         fileAccessStatRepo.softRemove = jest.fn();
         uploadedFileRepo.softRemove = jest.fn();
         fs.unlinkSync = jest.fn();
         fs.readdirSync = jest.fn().mockReturnValue([]);

         const result = await service.delete(1, relativePath);

         expect(result).toEqual([true, ""]);
         expect(fs.unlinkSync).toHaveBeenCalledWith(absolutePath);
         expect(uploadedFileRepo.findOne).toHaveBeenCalledWith({
            where: { absolute_path: relativePath, user: { id: user.id } },
         });
         expect(fileAccessStatRepo.find).toHaveBeenCalledWith({
            where: { uploaded_file: { absolute_path: relativePath, id: 1 } },
         });
         expect(uploadedFileRepo.softRemove).toHaveBeenCalled();
         expect(fileAccessStatRepo.softRemove).toHaveBeenCalled();
      });

      it("should still delete file if it is not found in the database", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/path/to/file`;
         const relativePath = "path/to/file";
         userService.getById = jest.fn().mockResolvedValue(user);
         service.isOwner = jest.fn().mockResolvedValue(true);
         service.absolutePath = jest.fn().mockResolvedValue(absolutePath);
         service.getUserRootPath = jest.fn().mockResolvedValue(`${config.get("CLOUD_DIR")}/${user.email}`);

         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(null); // Simulating file not found
         fileAccessStatRepo.find = jest.fn().mockResolvedValue([]);
         fileAccessStatRepo.softRemove = jest.fn();

         const result = await service.delete(1, relativePath);

         expect(result).toEqual([true, ""]);
         expect(fs.unlinkSync).toHaveBeenCalled();
      });

      it("should return an error if an exception occurs during deletion", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const relativePath = "path/to/file";
         userService.getById = jest.fn().mockResolvedValue(user);
         service.isOwner = jest.fn().mockResolvedValue(true);
         service.absolutePath = jest.fn().mockRejectedValue(new Error("Failed to resolve absolute path")); // Simulating an error

         const result = await service.delete(1, relativePath);

         expect(result).toEqual([false, "Failed to resolve absolute path"]);
      });

      it("should delete all thumbnails associated with the file", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/cait.jpg`;
         const relativePath = "cait.jpg";
         const uploadedFile = { id: 69, absolute_path: relativePath };

         userService.getById = jest.fn().mockResolvedValue(user);
         service.isOwner = jest.fn().mockResolvedValue(true);
         service.getUserRootPath = jest.fn().mockResolvedValue(`${config.get("CLOUD_DIR")}/${user.email}`);

         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(uploadedFile);
         fileAccessStatRepo.find = jest.fn().mockResolvedValue([]);
         fileAccessStatRepo.softRemove = jest.fn();
         uploadedFileRepo.softRemove = jest.fn();
         fs.unlinkSync = jest.fn();
         fs.readdirSync = jest.fn().mockReturnValue([
            { name: `${uploadedFile.id}_100x100.jpg` },
            { name: `${uploadedFile.id}_100xundefined.jpg` },
            { name: "24_100x100.jpg" }, // <--- Shouldn't be deleted!!
         ]); // <--- this function is called by invalidateThumbnailsFor

         const result = await service.delete(1, relativePath);

         expect(result).toEqual([true, ""]);

         // fs delation
         const thumbailAbsolute = (path: string) =>
            `${config.get("CLOUD_DIR")}/${user.email}/${FilesService.METADATA_FOLDER_NAME}/${
               FilesService.THUMBNAILS_FOLDER_NAME
            }/${path}`;
         expect(fs.unlinkSync).toHaveBeenCalledWith(absolutePath);
         expect(fs.unlinkSync).toHaveBeenCalledWith(thumbailAbsolute(`${uploadedFile.id}_100x100.jpg`));
         expect(fs.unlinkSync).toHaveBeenCalledWith(thumbailAbsolute(`${uploadedFile.id}_100xundefined.jpg`));
         expect(fs.unlinkSync).not.toHaveBeenCalledWith(thumbailAbsolute("24_100x100.jpg"));

         expect(uploadedFileRepo.findOne).toHaveBeenCalledWith({
            where: { absolute_path: relativePath, user: { id: user.id } },
         });
         expect(fileAccessStatRepo.find).toHaveBeenCalledWith({
            where: { uploaded_file: { absolute_path: relativePath, id: 69 } },
         });
         expect(uploadedFileRepo.softRemove).toHaveBeenCalled();
         expect(fileAccessStatRepo.softRemove).toHaveBeenCalled();
      });
   });

   describe("toThumbnail", () => {
      it("should throw an error if the user does not have permission", async () => {
         userService.getById = jest.fn().mockResolvedValue({ id: -1, email: "cait@queen.com" } as User);
         service.isOwner = jest.fn().mockResolvedValue(false);

         await expect(service.toThumbnail("test/path", 1)).rejects.toThrowError(
            "You don't have permission to access this file",
         );
      });

      it("should throw an error if the file does not exist", async () => {
         const user = { id: 1, email: "cait@queen.com" } as User;
         userService.getById = jest.fn().mockResolvedValue(user);

         FilesService.detectFile = jest.fn().mockReturnValue("image/jpeg");
         service.isOwner = jest.fn().mockResolvedValue(true);
         fs.existsSync = jest.fn().mockReturnValue(false);

         await expect(service.toThumbnail("path/to/file.png", 1)).rejects.toThrowError(
            `${config.get("CLOUD_DIR")}/${user.email}/path/to/file.png does not exist`,
         );
      });

      it("should return the existing thumbnail if already generated", async () => {
         const mockFile = { id: 1 };
         const user = { id: 1, email: "cait@queen.com" } as User;
         userService.getById = jest.fn().mockResolvedValue(user);

         FilesService.detectFile = jest.fn().mockReturnValue("image/jpeg");
         service.isOwner = jest.fn().mockReturnValue(true);

         jest.spyOn(fs, "existsSync").mockReturnValue(true);

         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(mockFile);
         service.createMetaFolderIfNotExists = jest
            .fn()
            .mockResolvedValue(`${config.get("CLOUD_DIR")}/${user.email}/${FilesService.METADATA_FOLDER_NAME}`);

         jest.spyOn(fs, "existsSync").mockReturnValue(true);
         fs.createReadStream = jest.fn().mockReturnValue("readStream");

         const result = await service.toThumbnail("test/path.jpg", 1, 100, 100);
         expect(result).toBe("readStream");
         expect(fs.createReadStream).toHaveBeenCalledWith(
            `${config.get("CLOUD_DIR")}/${user.email}/${FilesService.METADATA_FOLDER_NAME}/${
               FilesService.THUMBNAILS_FOLDER_NAME
            }/1_100x100.jpg`,
         );
      });

      it("should create a new thumbnail if none exists for image file", async () => {
         const mockFile = { id: 1 };
         const user = { id: 2, email: "cait@queen.com" } as User;

         userService.getById = jest.fn().mockResolvedValue(user);
         FilesService.detectFile = jest.fn().mockReturnValue("image/jpeg");
         service.isOwner = jest.fn().mockResolvedValue(true);

         // Return true if file is not a thumbnail
         jest
            .spyOn(fs, "existsSync")
            .mockImplementation((path: string) => !path.includes(FilesService.THUMBNAILS_FOLDER_NAME));

         uploadedFileRepo.findOne = jest.fn().mockResolvedValue(mockFile);
         const metaDir = `${config.get("CLOUD_DIR")}/${user.email}/${FilesService.METADATA_FOLDER_NAME}`;
         service.createMetaFolderIfNotExists = jest.fn().mockResolvedValue(metaDir);

         let thumbnailPath = "";
         fs.createReadStream = jest.fn().mockImplementation((path: string) => {
            thumbnailPath = path;
            return {
               pipe: jest.fn().mockReturnValue({
                  toFile: jest.fn().mockReturnValue("thumbnail presisted to file"),
               }),
            };
         });

         const result = await service.toThumbnail("test/path.jpg", 1, 120, 100);
         expect(result).toBeDefined(); // assuming the result would be a stream
         expect(thumbnailPath).toBe(`${metaDir}/${FilesService.THUMBNAILS_FOLDER_NAME}/${mockFile.id}_120x100.jpg`);
      });

      it("should generate and return a video thumbnail", async () => {
         const absolutePath = "/path/to/video.mp4";
         service.absolutePath = jest.fn().mockResolvedValue(absolutePath);
         FilesService.detectFile = jest.fn().mockReturnValue("video/mp4");
         service.isOwner = jest.fn().mockResolvedValue(true);
         service.createMetaFolderIfNotExists = jest.fn().mockResolvedValue("/meta/folder");

         const genFn = jest.fn().mockResolvedValue(true);
         ThumbnailGenerator.mockImplementation(() => ({
            getThumbnail: genFn,
         }));

         fs.createReadStream = jest.fn().mockReturnValue("readStream");

         const result = await service.toThumbnail("test/video.mp4", 1, 100, 100);
         expect(result).toBe("readStream");
         expect(ThumbnailGenerator).toHaveBeenCalledWith({
            verbose: false,
            size: [100, 100],
            quality: 70,
         });
         expect(genFn).toBeCalledWith({
            path: absolutePath,
            output: "/path/to/.videometa.video.mp4.png",
         });
      });

      it("should handle missing width or height gracefully", async () => {
         service.absolutePath = jest.fn().mockResolvedValue("/path/to/file");
         FilesService.detectFile = jest.fn().mockReturnValue("image/jpeg");
         service.isOwner = jest.fn().mockResolvedValue(true);

         jest.spyOn(fs, "existsSync").mockReturnValue(true);

         fs.createReadStream = jest.fn().mockReturnValue({ pipe: jest.fn().mockReturnValue("Mocked image data") });

         const result = await service.toThumbnail("test/path", 1); // no width, no height
         expect(result).toBe("Mocked image data");
      });

      it("should handle unsupported mime types gracefully", async () => {
         service.absolutePath = jest.fn().mockResolvedValue("/path/to/file");
         FilesService.detectFile = jest.fn().mockReturnValue("application/pdf");
         service.isOwner = jest.fn().mockResolvedValue(true);

         fs.createReadStream = jest.fn().mockReturnValue("data");

         await expect(service.toThumbnail("test/path", 1, 100, 100)).resolves.toBeNull();
      });
   });

   describe("isOwner", () => {
      it("should return true if user is the owner (sanitized relative path is valid)", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/files`;

         userService.getById = jest.fn().mockResolvedValue(user);

         const result = await service.isOwner(user.id, absolutePath);

         expect(result).toBe(true);
         expect(logger.log).not.toHaveBeenCalled(); // No log should be generated if user is owner
      });

      it("should return false if user is trying to access a file outside their root directory", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/other@shado.com/files`;

         userService.getById = jest.fn().mockResolvedValue(user);

         const result = await service.isOwner(user.id, absolutePath);

         expect(result).toBe(false);
         expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining(`Not owner of ${config.get("CLOUD_DIR")}/other@shado.com/files`),
         );
      });

      it('should return false if the relative path includes ".." and tries to go outside the root path', async () => {
         const user = { id: 1, email: "cait@queen.com" };

         // ".." to go outside of the root path
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/../other@shado.com/file.txt`;

         userService.getById = jest.fn().mockResolvedValue(user);

         const result = await service.isOwner(user.id, absolutePath);

         expect(result).toBe(false);
         expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`Not owner of ${absolutePath}`));
      });

      it("should return true if the sanitized relative path is empty (path points directly to the root)", async () => {
         const user = { id: 1, email: "cait@queen.com" };
         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}`;

         userService.getById = jest.fn().mockResolvedValue(user);

         const result = await service.isOwner(user.id, absolutePath);

         expect(result).toBe(true);
         expect(logger.log).not.toHaveBeenCalled(); // No log should be generated if user is owner
      });

      it('should return false if path traversal ".." is used multiple times to go out of the root path', async () => {
         const user = { id: 1, email: "cait@queen.com" };

         const absolutePath = `${config.get("CLOUD_DIR")}/${user.email}/../../etc/passwd`;

         userService.getById = jest.fn().mockResolvedValue(user);

         const result = await service.isOwner(user.id, absolutePath);

         expect(result).toBe(false);
         expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`Not owner of ${absolutePath}`));
      });
   });

   describe("replaceIllegalChars", () => {
      it("should remove leading dots from hidden folder names", () => {
         const filename = ".hiddenFile.txt";
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe("hiddenFile.txt");
      });

      it("should remove illegal characters from the filename", () => {
         const filename = "file?name!with[illegal]chars*.txt";
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe("filenamewithillegalchars.txt"); // All illegal chars should be removed
      });

      it("should handle a filename with multiple illegal characters", () => {
         const filename = 'f?i!l[e]n:a"m@e*.txt';
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe("filename.txt"); // All illegal chars should be removed
      });

      it("should return current date if the filename becomes empty after sanitization", () => {
         const filename = "??????"; // All illegal characters, result should be empty
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe(mockDate.toLocaleDateString().replace(":", "-")); // Should return the mock date, with ":" replaced by "-"
      });

      it("should leave valid filenames unchanged", () => {
         const filename = "validFileName.txt";
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe("validFileName.txt"); // No illegal chars, filename stays the same
      });

      it("should handle filenames with only illegal characters and return the current date", () => {
         const filename = '@|<>:"'; // Only illegal characters, should be replaced with date
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe(mockDate.toLocaleDateString().replace(":", "-"));
      });

      it("should remove only the illegal characters and keep other parts of the filename intact", () => {
         const filename = "file[123]@test!.txt";
         const result = service.replaceIllegalChars(filename);
         expect(result).toBe("file123test.txt"); // Only illegal chars should be removed
      });
   });
});
