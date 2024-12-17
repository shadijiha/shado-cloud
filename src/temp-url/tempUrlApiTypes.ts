/**
 *
 *
 */

import { ApiProperty } from "@nestjs/swagger";

export class TempURLGenerateOptions {
    @ApiProperty({ default: 100 })
    max_requests: number;

    @ApiProperty({ default: true })
    is_readonly: boolean;

    @ApiProperty({ default: new Date(Date.now() + 60 * 60 * 24 * 1000) })
    expires_at: Date;

    @ApiProperty()
    filepath: string;
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
