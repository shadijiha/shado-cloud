import { ApiProperty } from "@nestjs/swagger";
import { ErrorProne } from "../auth/authApiTypes";
import { enumToArray } from "../util";

export class NewFileRequest {
   @ApiProperty({ example: "Relative path + file name + file extension" })
   name: string;
}

export class SaveFileRequest extends NewFileRequest {
   @ApiProperty()
   content: string;

   @ApiProperty({ default: false })
   append?: boolean = false;
}

export class RenameFileRequest extends NewFileRequest {
   @ApiProperty({ example: "Name + extension" })
   newName: string;
}

export enum OperationStatus {
   FAILED,
   SUCCESS,
   ONGOING,
   UNKNOWN,
}

export class OperationStatusResponse extends ErrorProne {
   @ApiProperty({
      enum: enumToArray(OperationStatus),
   })
   status: string;
}

/**
 * Represents information about a file
 */
export class FileInfo {
   @ApiProperty()
   name: string;

   @ApiProperty()
   extension: string;

   @ApiProperty()
   path: string;

   @ApiProperty()
   mime: string;

   @ApiProperty()
   size: number;

   @ApiProperty()
   lastModified: string;

   @ApiProperty()
   is_image: boolean;

   @ApiProperty()
   is_video: boolean;

   @ApiProperty()
   is_pdf: boolean;

   @ApiProperty()
   is_text: boolean;

   @ApiProperty()
   is_audio: boolean;

   @ApiProperty({ description: "True if the file currently lives on a cold-storage drive (tiered)." })
   is_cold_storage: boolean;

   @ApiProperty({ required: false, description: "Total files under this directory (directories only)." })
   file_count?: number;

   @ApiProperty({ required: false, description: "Files under this directory that are in cold storage (directories only)." })
   cold_file_count?: number;

   @ApiProperty()
   is_dir = false;
}

export class FileInfoResponse extends ErrorProne {
   @ApiProperty({
      enum: enumToArray(OperationStatus),
   })
   status: string;

   @ApiProperty()
   data: FileInfo;
}

export class OpResWithData extends OperationStatusResponse {
   @ApiProperty()
   data: boolean;
}

/**
 * A single place a copy of a file may live: the primary cloud-dir, a locally
 * configured mirror disk, or a replica node.
 */
export class BackupLocation {
   @ApiProperty({ enum: ["primary", "mirror", "replica"] })
   kind: "primary" | "mirror" | "replica";

   @ApiProperty({ description: "Human-readable name of this backup location." })
   label: string;

   @ApiProperty({
      nullable: true,
      description:
         "true = copy confirmed present, false = absent/pending, null = unknown (e.g. mirror disk unmounted, or replica reachability not verified).",
   })
   present: boolean | null;

   @ApiProperty({ required: false, description: "Extra context (path, last sync time, ignore-rule note, etc.)." })
   detail?: string;
}

export class FileBackups {
   @ApiProperty({ description: "File path relative to cloud-dir." })
   path: string;

   @ApiProperty({ description: "Replication role of the node that answered (master/primary/replica)." })
   role: string;

   @ApiProperty({ description: "True if the file matches a replication ignore pattern (replicas will not hold it)." })
   ignored: boolean;

   @ApiProperty({ description: "Number of locations where a copy is confirmed present." })
   confirmedCopies: number;

   @ApiProperty({ type: [BackupLocation] })
   locations: BackupLocation[];
}

export class FileBackupsResponse extends ErrorProne {
   @ApiProperty({
      enum: enumToArray(OperationStatus),
   })
   status: string;

   @ApiProperty({ nullable: true })
   data: FileBackups | null;
}
