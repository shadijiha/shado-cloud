/**
 *
 */

import { ApiProperty } from "@nestjs/swagger";
import { ErrorProne } from "src/auth/authApiTypes";
import { type FileInfo, OperationStatus } from "src/files/filesApiTypes";
import { enumToArray } from "src/util";

export class DirectoryInfo {
   @ApiProperty()
   path: string;

   @ApiProperty()
   name: string;

   @ApiProperty()
   lastModified: string;

   @ApiProperty()
   is_dir = true;
}

export class DirListResponse extends ErrorProne {
   @ApiProperty({
      enum: enumToArray(OperationStatus),
   })
   status: string;

   @ApiProperty()
   parent: string;

   @ApiProperty({ type: [Object] })
   data: Array<DirectoryInfo | FileInfo>;

   @ApiProperty({
      example: { itemsPerPage: 50, totalItems: 100, currentPage: 1, totalPages: 2, sortBy: [], searchBy: [], search: "", select: [] },
   })
   meta: {
      itemsPerPage: number;
      totalItems: number;
      currentPage: number;
      totalPages: number;
      sortBy: any[];
      searchBy: any[];
      search: string;
      select: string[];
   };

   @ApiProperty({
      example: { current: "" },
   })
   links: {
      first?: string;
      previous?: string;
      current: string;
      next?: string;
      last?: string;
   };
}

export class NewDirRequest {
   @ApiProperty({ example: "relative path + name" })
   name: string;
}

export class RenameDirRequest extends NewDirRequest {
   @ApiProperty({ example: "new relative path + name" })
   newName: string;
}
