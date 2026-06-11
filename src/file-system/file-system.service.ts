import { Injectable } from "@nestjs/common";
import fs from "fs";
import {
   AbstractFileSystem,
   type Dirent,
   type MakeDirectoryOptions,
   type PathLike,
   type State,
} from "./abstract-file-system.interface";
import { type Readable, type Writable } from "stream";

@Injectable()
export class NodeFileSystemService extends AbstractFileSystem {
   public async lstat(path: string): Promise<State> {
      return fs.lstatSync(path);
   }

   public async readdir(
      path: PathLike,
      options?: {
         encoding?: BufferEncoding | null | undefined;
      },
   ): Promise<Dirent[]> {
      return fs.readdirSync(path, { ...options, withFileTypes: true });
   }

   public async stat(path: string): Promise<State> {
      return fs.statSync(path);
   }

   public async createWriteStream(path: PathLike, options?: BufferEncoding): Promise<Writable> {
      return fs.createWriteStream(path, options);
   }

   public async rmdir(path: string, options: { recursive: boolean }): Promise<void> {
      fs.rmSync(path, { recursive: options?.recursive || false, force: true });
   }

   public async appendFile(path: string, content: string): Promise<void> {
      fs.appendFileSync(path, content);
   }

   public async mkdir(path: string, options?: MakeDirectoryOptions): Promise<string> {
      return fs.mkdirSync(path, options);
   }

   public async createReadStream(path: PathLike, options?: BufferEncoding): Promise<Readable> {
      return fs.createReadStream(path, options);
   }

   public async unlink(path: string): Promise<void> {
      fs.unlinkSync(path);
   }

   public async rename(path: string, newPath: string): Promise<void> {
      fs.renameSync(path, newPath);
   }

   public async writeFile(path: string, content: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding): Promise<void> {
      fs.writeFileSync(path, content, encoding);
   }

   public async readFile(path: string, encoding: BufferEncoding): Promise<string | Buffer> {
      return fs.readFileSync(path, encoding);
   }

   public async exists(path: string): Promise<boolean> {
      return fs.existsSync(path);
   }
}
