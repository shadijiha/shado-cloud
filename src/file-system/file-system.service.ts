import { Injectable } from '@nestjs/common'
import fs from 'fs'
import { AbstractFileSystem, type Dirent, type MakeDirectoryOptions, type PathLike, type State } from './abstract-file-system.interface'
import { type Readable, type Writable } from 'stream'

@Injectable()
export class NodeFileSystemService extends AbstractFileSystem {
  public lstatSync (path: string): State {
    return fs.lstatSync(path)
  }

  public readdirSync (
    path: PathLike,
    options?: {
      encoding?: BufferEncoding | null | undefined
    }
  ): Dirent[] {
    return fs.readdirSync(path, { ...options, withFileTypes: true })
  }

  public statSync (path: string): State {
    return fs.statSync(path)
  }

  public createWriteStream (path: PathLike, options?: BufferEncoding): Writable {
    return fs.createWriteStream(path, options)
  }

  public rmdirSync (path: string, options: { recursive: boolean }): void {
    fs.rmdirSync(path, options)
  }

  public appendFileSync (path: string, content: string): void {
    fs.appendFileSync(path, content)
  }

  public mkdirSync (path: string, options?: MakeDirectoryOptions) {
    return fs.mkdirSync(path, options)
  }

  public createReadStream (path: PathLike, options?: BufferEncoding): Readable {
    return fs.createReadStream(path, options)
  }

  public unlinkSync (path: string): void {
    fs.unlinkSync(path)
  }

  public renameSync (path: string, newPath: string): void {
    fs.renameSync(path, newPath)
  }

  public writeFileSync (path: string, content: string | NodeJS.ArrayBufferView): void {
    fs.writeFileSync(path, content)
  }

  public readFileSync (path: string, encoding: BufferEncoding): string | Buffer {
    return fs.readFileSync(path, encoding)
  }

  public existsSync (path: string): boolean {
    return fs.existsSync(path)
  }
}
