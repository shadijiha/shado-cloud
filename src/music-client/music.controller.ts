import {
   Body,
   Controller,
   Delete,
   Get,
   Inject,
   Param,
   ParseIntPipe,
   Post,
   Query,
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
@ApiTags("Music")
export class MusicController {
   constructor(
      @Inject(MUSIC_SERVICE) private readonly client: ClientProxy,
      private readonly fileService: FilesService,
   ) {}

   // ── Search ──────────────────────────────────────────────

   @Get("search")
   async search(@AuthUser() userId: number, @Query("q") query: string) {
      return firstValueFrom(this.client.send("music.search", { userId, query }));
   }

   // ── Songs ───────────────────────────────────────────────

   @Get("songs")
   async allSongs() {
      return firstValueFrom(this.client.send("music.allSongs", {}));
   }

   @Post("songs/:id/play")
   async recordPlay(@AuthUser() userId: number, @Param("id", ParseIntPipe) id: number) {
      return firstValueFrom(this.client.send("music.recordPlay", { userId, songId: id }));
   }

   // ── Library ─────────────────────────────────────────────

   @Get("library")
   async library(@AuthUser() userId: number) {
      return firstValueFrom(this.client.send("music.library", { userId }));
   }

   // ── Streaming (FilesService reads directly) ─────────────

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

   // ── Pull from YouTube ───────────────────────────────────

   @Post("pull")
   async pull(@Body() body: { youtubeUrl: string; title?: string; artist?: string }) {
      return firstValueFrom(this.client.send("music.pull", body));
   }

   @Get("youtube-playlist/:id")
   async previewYoutubePlaylist(@Param("id") playlistId: string) {
      return firstValueFrom(this.client.send("music.previewYoutubePlaylist", { playlistId }));
   }

   // ── Pull/Import playlist (SSE via Observable over TCP) ──

   @Post("pull-playlist")
   async pullPlaylist(
      @AuthUser() userId: number,
      @Body() body: { playlistUrl: string; playlistName?: string },
      @Res() res: Response,
   ) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      this.client.send("music.pullPlaylist", { userId, ...body }).subscribe({
         next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
         error: (e) => {
            res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
            res.end();
         },
         complete: () => res.end(),
      });
   }

   @Post("import-playlist")
   async importPlaylist(@AuthUser() userId: number, @Body() body: { url: string }, @Res() res: Response) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      this.client.send("music.importPlaylist", { userId, ...body }).subscribe({
         next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
         error: (e) => {
            res.write(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
            res.end();
         },
         complete: () => res.end(),
      });
   }

   // ── Playlists ───────────────────────────────────────────

   @Get("playlists")
   async getPlaylists(@AuthUser() userId: number) {
      return firstValueFrom(this.client.send("music.playlists", { userId }));
   }

   @Post("songs/:id/love")
   async toggleLove(@AuthUser() userId: number, @Param("id", ParseIntPipe) id: number) {
      return firstValueFrom(this.client.send("music.toggleLove", { userId, songId: id }));
   }

   @Get("loved")
   async getLovedIds(@AuthUser() userId: number) {
      return firstValueFrom(this.client.send("music.lovedIds", { userId }));
   }

   @Post("playlists")
   async createPlaylist(@AuthUser() userId: number, @Body() body: { name: string }) {
      return firstValueFrom(this.client.send("music.createPlaylist", { userId, name: body.name }));
   }

   @Delete("playlists/:id")
   async deletePlaylist(@AuthUser() userId: number, @Param("id", ParseIntPipe) id: number) {
      return firstValueFrom(this.client.send("music.deletePlaylist", { userId, playlistId: id }));
   }

   @Post("playlists/:id/songs")
   async addSong(@AuthUser() userId: number, @Param("id", ParseIntPipe) id: number, @Body() body: { songId: number }) {
      return firstValueFrom(this.client.send("music.addSong", { userId, playlistId: id, songId: body.songId }));
   }

   @Delete("playlists/:playlistId/songs/:songId")
   async removeSong(
      @AuthUser() userId: number,
      @Param("playlistId", ParseIntPipe) playlistId: number,
      @Param("songId", ParseIntPipe) songId: number,
   ) {
      return firstValueFrom(this.client.send("music.removeSong", { userId, playlistId, songId }));
   }
}
