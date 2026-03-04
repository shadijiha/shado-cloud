import {
   All,
   Controller,
   Get,
   Inject,
   Param,
   ParseIntPipe,
   Req,
   Res,
   UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ClientProxy } from "@nestjs/microservices";
import { ApiTags } from "@nestjs/swagger";
import { type Request, type Response } from "express";
import { AuthUser } from "src/util";
import { MUSIC_SERVICE } from "./constants";
import { firstValueFrom } from "rxjs";
import { FilesService } from "src/files/files.service";

@Controller("music")
@UseGuards(AuthGuard("jwt"))
@ApiTags("Music — proxied to shado-music-api (see github.com/shadijiha/shado-music-api)")
export class MusicController {
   constructor(
      @Inject(MUSIC_SERVICE) private readonly client: ClientProxy,
      private readonly fileService: FilesService,
   ) {}

   // ── Explicit streaming endpoints (need FilesService) ────

   @Get("songs/:id/stream")
   async streamSong(@Param("id", ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response) {
      const info = await firstValueFrom(this.client.send("music.streamSong", { songId: id }));
      if (info.error) return res.status(info.status).json({ error: info.error });

      const total = info.total;

      if (req.headers.range) {
         const parts = req.headers.range.replace(/bytes=/, "").split("-");
         const start = parseInt(parts[0], 10);
         const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
         res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            "Content-Type": info.contentType,
         });
         (await this.fileService.asStream(info.userId, info.relativePath, req.headers["user-agent"], { start, end })).pipe(res);
      } else {
         res.writeHead(200, { "Content-Length": total, "Content-Type": info.contentType });
         (await this.fileService.asStream(info.userId, info.relativePath, req.headers["user-agent"])).pipe(res);
      }
   }

   @Get("songs/:id/thumbnail")
   async songThumbnail(@Param("id", ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response) {
      const info = await firstValueFrom(this.client.send("music.songThumbnail", { songId: id }));
      if (info.error) return res.status(info.status || 404).json({ error: info.error });

      res.writeHead(200, { "Content-Type": info.contentType });
      (await this.fileService.asStream(info.userId, info.relativePath, req.headers["user-agent"])).pipe(res);
   }

   // ── SSE endpoints (need manual res.write) ───────────────

   @All("pull-playlist")
   async pullPlaylist(@AuthUser() userId: number, @Req() req: Request, @Res() res: Response) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      this.client.send("music.pullPlaylist", { userId, ...req.body }).subscribe({
         next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
         error: (e) => { res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`); res.end(); },
         complete: () => res.end(),
      });
   }

   @All("import-playlist")
   async importPlaylist(@AuthUser() userId: number, @Req() req: Request, @Res() res: Response) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      this.client.send("music.importPlaylist", { userId, ...req.body }).subscribe({
         next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
         error: (e) => { res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`); res.end(); },
         complete: () => res.end(),
      });
   }

   // ── Generic TCP proxy for everything else ───────────────

   @All("*path")
   async proxy(@AuthUser() userId: number, @Req() req: Request, @Res() res: Response) {
      const musicPath = req.url; // e.g. /search?q=test, /playlists, /songs/1/play
      const pattern = "music.proxy";
      const payload = {
         userId,
         method: req.method,
         path: musicPath,
         body: req.body,
         query: req.query,
      };

      try {
         const result = await firstValueFrom(this.client.send(pattern, payload));
         res.json(result);
      } catch (e) {
         res.status(502).json({ error: "Music service unavailable" });
      }
   }
}
