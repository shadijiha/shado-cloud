import { type Readable, type Writable } from "stream";

export type PathLike = string | Buffer | URL;

export interface MakeDirectoryOptions {
   /**
    * Indicates whether parent folders should be created.
    * If a folder was created, the path to the first created folder will be returned.
    * @default false
    */
   recursive?: boolean | undefined;

   /**
    * A file mode. If a string is passed, it is parsed as an octal integer.
    * If not specified, the default mode is `0o777`.
    * @default 0o777
    */
   mode?: number | string | undefined;
}

export interface State {
   /**
    * Returns true if the file is a regular file.
    */
   isFile: () => boolean;

   /**
    * Returns true if the file is a directory.
    */
   isDirectory: () => boolean;

   /**
    * Returns true if the file is a block device.
    */
   isBlockDevice: () => boolean;

   /**
    * Returns true if the file is a character device.
    */
   isCharacterDevice: () => boolean;

   /**
    * Returns true if the file is a symbolic link.
    */
   isSymbolicLink: () => boolean;

   /**
    * Returns true if the file is a FIFO (first-in-first-out) pipe.
    */
   isFIFO: () => boolean;

   /**
    * Returns true if the file is a socket.
    */
   isSocket: () => boolean;

   /**
    * The device ID of the file.
    */
   dev: number;

   /**
    * The inode number of the file.
    */
   ino: number;

   /**
    * The file mode (permissions and type).
    */
   mode: number;

   /**
    * The number of hard links to the file.
    */
   nlink: number;

   /**
    * The user ID of the file's owner.
    */
   uid: number;

   /**
    * The group ID of the file's group.
    */
   gid: number;

   /**
    * The device ID of the file (for devices).
    */
   rdev: number;

   /**
    * The size of the file in bytes.
    */
   size: number;

   /**
    * The block size used for file system I/O.
    */
   blksize: number;

   /**
    * The number of blocks allocated for the file.
    */
   blocks: number;

   /**
    * The last access time of the file in milliseconds.
    */
   atimeMs: number;

   /**
    * The last modification time of the file in milliseconds.
    */
   mtimeMs: number;

   /**
    * The last change time of the file's metadata in milliseconds.
    */
   ctimeMs: number;

   /**
    * The creation time of the file in milliseconds (if available).
    */
   birthtimeMs: number;

   /**
    * The last access time of the file.
    */
   atime: Date;

   /**
    * The last modification time of the file.
    */
   mtime: Date;

   /**
    * The last change time of the file's metadata.
    */
   ctime: Date;

   /**
    * The creation time of the file (if available).
    */
   birthtime: Date;
}

export interface Dirent {
   /**
    * Returns `true` if the `fs.Dirent` object describes a regular file.
    * @since v10.10.0
    */
   isFile: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a file system directory.
    * @since v10.10.0
    */
   isDirectory: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a block device.
    * @since v10.10.0
    */
   isBlockDevice: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a character device.
    * @since v10.10.0
    */
   isCharacterDevice: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a symbolic link.
    * @since v10.10.0
    */
   isSymbolicLink: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a FIFO pipe.
    * @since v10.10.0
    */
   isFIFO: () => boolean;

   /**
    * Returns `true` if the `fs.Dirent` object describes a socket.
    * @since v10.10.0
    */
   isSocket: () => boolean;

   /**
    * The file name that this `fs.Dirent` object refers to. The type of this
    * value is determined by the `options.encoding` passed to {@link readdir} or {@link readdirSync}.
    * @since v10.10.0
    */
   name: string;
}

export abstract class AbstractFileSystem {
   /**
    * Synchronously writes data to a file.
    *
    * @param path The path to the file.
    * @param content The data to write to the file.
    * @throws Will throw an error if the file cannot be written.
    */
   public abstract writeFileSync(path: string, content: string | NodeJS.ArrayBufferView): void;

   /**
    * Synchronously reads the entire contents of a file.
    *
    * @param path The path to the file.
    * @param encoding The encoding to use for reading the file.
    * @returns The contents of the file as a string or Buffer.
    * @throws Will throw an error if the file cannot be read.
    */
   public abstract readFileSync(path: string, encoding: BufferEncoding): string | Buffer;

   /**
    * Synchronously checks if a file or directory exists at the specified path.
    *
    * @param path The path to check.
    * @returns `true` if the path exists, `false` otherwise.
    */
   public abstract existsSync(path: string): boolean;

   /**
    * Synchronously renames a file or directory.
    *
    * @param path The current path to the file or directory.
    * @param newPath The new path to the file or directory.
    * @throws Will throw an error if the rename operation fails.
    */
   public abstract renameSync(path: string, newPath: string): void;

   /**
    * Synchronously removes a file or symbolic link.
    *
    * @param path The path to the file or symbolic link to remove.
    * @throws Will throw an error if the unlink operation fails.
    */
   public abstract unlinkSync(path: string): void;

   /**
    * Creates a readable stream for the specified file.
    *
    * @param path The path to the file.
    * @param options Optional encoding for the file contents.
    * @returns A readable stream for the file.
    * @throws Will throw an error if the file cannot be opened.
    */
   public abstract createReadStream(path: PathLike, options?: BufferEncoding): Readable;

   /**
    * Creates a writable stream for the specified file.
    *
    * @param path The path to the file.
    * @param options Optional encoding for the file contents.
    * @returns A writable stream for the file.
    * @throws Will throw an error if the file cannot be opened for writing.
    */
   public abstract createWriteStream(path: PathLike, options?: BufferEncoding): Writable;

   /**
    * Synchronously creates a directory.
    *
    * @param path The path to the directory to create.
    * @param options Optional settings for directory creation.
    * @throws Will throw an error if the directory cannot be created.
    */
   public abstract mkdirSync(path: string, options?: MakeDirectoryOptions): void;

   /**
    * Synchronously removes a directory.
    *
    * @param path The path to the directory to remove.
    * @param options Optional settings for recursive deletion.
    * @throws Will throw an error if the directory cannot be removed.
    */
   public abstract rmdirSync(path: string, options?: { recursive: boolean }): void;

   /**
    * Synchronously appends data to a file.
    *
    * @param path The path to the file.
    * @param content The data to append to the file.
    * @throws Will throw an error if the file cannot be appended.
    */
   public abstract appendFileSync(path: string, content: string): void;

   /**
    * Synchronously reads the contents of a directory.
    *
    * @param path The path to the directory.
    * @param options Optional settings for encoding.
    * @returns A list of directory entries (`fs.Dirent`) in the directory.
    * @throws Will throw an error if the directory cannot be read.
    */
   public abstract readdirSync(
      path: PathLike,
      options?: {
         encoding?: BufferEncoding | null | undefined;
      },
   ): Dirent[];

   /**
    * Synchronously retrieves information about a file or directory.
    *
    * @param path The path to the file or directory.
    * @returns A `State` object containing the file or directory's metadata.
    * @throws Will throw an error if the file or directory cannot be stat-ed.
    */
   public abstract statSync(path: string): State;

   /**
    * Synchronously retrieves information about a symbolic link or file.
    *
    * @param path The path to the symbolic link or file.
    * @returns A `State` object containing the symbolic link's metadata.
    * @throws Will throw an error if the symbolic link or file cannot be stat-ed.
    */
   public abstract lstatSync(path: string): State;
}
