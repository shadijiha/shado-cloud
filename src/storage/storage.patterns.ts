/**
 * TCP message patterns for the Storage microservice.
 * Shared between the gateway (main app) and the microservice.
 */
export const STORAGE_SERVICE = "STORAGE_SERVICE" as const;

export const StoragePatterns = {
   // Files
   FILE_UPLOAD: "file.upload",
   FILE_NEW: "file.new",
   FILE_SAVE: "file.save",
   FILE_DELETE: "file.delete",
   FILE_RENAME: "file.rename",
   FILE_INFO: "file.info",
   FILE_EXISTS: "file.exists",
   FILE_STREAM: "file.stream",
   FILE_THUMBNAIL: "file.thumbnail",
   FILE_PROFILE_PICTURE_INFO: "file.profilePictureInfo",
   FILE_GET_USED_DATA: "file.getUsedData",
   FILE_GET_USER_ROOT_PATH: "file.getUserRootPath",
   FILE_ABSOLUTE_PATH: "file.absolutePath",
   FILE_IS_OWNER: "file.isOwner",
   FILE_DETECT: "file.detect",
   FILE_CREATE_META_FOLDER: "file.createMetaFolder",
   FILE_VERIFY_FILE_NAME: "file.verifyFileName",

   // Directories
   DIR_ROOT: "dir.root",
   DIR_LIST: "dir.list",
   DIR_LIST_RECURSIVE: "dir.listRecursive",
   DIR_NEW: "dir.new",
   DIR_DELETE: "dir.delete",
   DIR_RENAME: "dir.rename",
   DIR_SEARCH: "dir.search",
   DIR_ZIP: "dir.zip",
   DIR_UNZIP: "dir.unzip",
   DIR_CREATE_USER_DIR: "dir.createUserDir",

   // Temp URLs
   TEMP_GENERATE: "temp.generate",
   TEMP_STREAM: "temp.stream",
   TEMP_SAVE: "temp.save",
   TEMP_LIST: "temp.list",
   TEMP_DELETE: "temp.delete",
} as const;
