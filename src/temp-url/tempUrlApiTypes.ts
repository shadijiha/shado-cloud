/**
 *
 *
 */

import { ApiProperty } from "@nestjs/swagger";
import { TempUrlAccessLevel } from "../models/tempUrl";

export class TempURLGenerateOptions {
   @ApiProperty({ default: 100 })
   max_requests: number;

   @ApiProperty({ default: true })
   is_readonly: boolean;

   @ApiProperty({ default: new Date(Date.now() + 60 * 60 * 24 * 7 * 1000) })
   expires_at: Date;

   @ApiProperty()
   filepath: string;

   // Optional access control for the share. Defaults to "public" (token-only access).
   //  - "public"        : anybody with the link.
   //  - "authenticated" : any signed-in Shado user (session cookie required).
   //  - "restricted"    : FUTURE — a specific allow-list of users (rejected for now).
   @ApiProperty({ enum: TempUrlAccessLevel, default: TempUrlAccessLevel.PUBLIC, required: false })
   access_level?: TempUrlAccessLevel;
}

export class TempURLGenerateResponse {
   @ApiProperty()
   url: string;
}

export class TempURLSaveRequest {
   @ApiProperty()
   content: string;

   @ApiProperty({ default: false })
   append: boolean;
}

/**
 * Metadata about a shared token, used by the public frontend explorer to decide how
 * to render the share (single file vs. browsable directory) without consuming the
 * request quota.
 */
export class TempURLMetaResponse {
   @ApiProperty()
   url: string;

   @ApiProperty()
   is_dir: boolean;

   @ApiProperty()
   is_readonly: boolean;

   @ApiProperty({ enum: TempUrlAccessLevel })
   access_level: TempUrlAccessLevel;

   @ApiProperty()
   is_valid: boolean;

   // Base name of the shared file/directory (never the full server path).
   @ApiProperty()
   name: string;

   @ApiProperty({ required: false, nullable: true })
   mime?: string | null;

   @ApiProperty()
   requests: number;

   @ApiProperty()
   max_requests: number;

   @ApiProperty()
   expires_at: Date;
}

/** A single entry inside a shared directory listing. */
export class TempURLDirEntry {
   @ApiProperty()
   name: string;

   @ApiProperty()
   is_dir: boolean;

   // Path relative to the share root ("" is the share root itself). Safe to hand back
   // to /temp/:url/list and /temp/:url/get as the `path` query param.
   @ApiProperty()
   path: string;

   @ApiProperty({ required: false })
   size?: number;

   @ApiProperty({ required: false, nullable: true })
   mime?: string | null;

   @ApiProperty()
   lastModified: string;

   // Convenience type flags (mirrors FilesService.info) so the frontend can reuse the
   // same FileGrid rendering (icons + thumbnails) it uses for the authenticated browser.
   @ApiProperty()
   extension: string;

   @ApiProperty()
   is_image: boolean;

   @ApiProperty()
   is_video: boolean;

   @ApiProperty()
   is_audio: boolean;

   @ApiProperty()
   is_pdf: boolean;

   @ApiProperty()
   is_text: boolean;
}

/** Listing of a sub-path within a shared directory. */
export class TempURLListResponse {
   @ApiProperty()
   url: string;

   // The sub-path (relative to the share root) that was listed.
   @ApiProperty()
   path: string;

   @ApiProperty({ type: [TempURLDirEntry] })
   entries: TempURLDirEntry[];

   @ApiProperty({ type: [String], description: "Field/message error pairs" })
   errors: { field: string; message: string }[];
}
