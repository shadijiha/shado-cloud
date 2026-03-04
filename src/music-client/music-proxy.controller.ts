import { All, Controller, Req, Res, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { HttpService } from "@nestjs/axios";
import { type Request, type Response } from "express";

const MUSIC_HTTP = `http://${process.env.MUSIC_SERVICE_HOST || "localhost"}:${process.env.MUSIC_API_PORT || 9001}`;

@Controller("music")
@UseGuards(AuthGuard("jwt"))
export class MusicProxyController {
   constructor(private readonly http: HttpService) {}

   @All("*path")
   async proxy(@Req() req: Request, @Res() res: Response) {
      const url = `${MUSIC_HTTP}/music${req.url}`;
      const headers: Record<string, string> = {};
      if (req.headers.cookie) headers.Cookie = req.headers.cookie;
      if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      if (req.headers.range) headers.Range = req.headers.range;

      try {
         const upstream = await this.http.axiosRef.request({
            method: req.method as any,
            url,
            headers,
            data: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
            params: req.query,
            responseType: "stream",
            timeout: 0,
            validateStatus: () => true,
            maxRedirects: 0,
         });

         res.status(upstream.status);
         for (const [k, v] of Object.entries(upstream.headers)) {
            if (v && !["transfer-encoding"].includes(k.toLowerCase())) {
               res.setHeader(k, v as string);
            }
         }
         upstream.data.pipe(res);
      } catch (e) {
         res.status(502).json({ error: "Music service unavailable" });
      }
   }
}
