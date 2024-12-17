/**
 *
 */

import { ApiProperty } from '@nestjs/swagger'
import { ErrorProne } from 'src/auth/authApiTypes'
import { type FileInfo, OperationStatus } from 'src/files/filesApiTypes'
import { enumToArray } from 'src/util'

export class DirectoryInfo {
  @ApiProperty()
    path: string

  @ApiProperty()
    name: string

  @ApiProperty()
    is_dir = true
}

export class DirListResponse extends ErrorProne {
  @ApiProperty({
    enum: enumToArray(OperationStatus)
  })
    status: string

  @ApiProperty()
    parent: string

  @ApiProperty({ type: [Object] })
    data: Array<DirectoryInfo | FileInfo>
}

export class NewDirRequest {
  @ApiProperty({ example: 'relative path + name' })
    name: string
}

export class RenameDirRequest extends NewDirRequest {
  @ApiProperty({ example: 'new relative path + name' })
    newName: string
}
