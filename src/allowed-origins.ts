import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "./config/config.validator";

/**
 * Single source of truth for which browser origins are trusted by this service.
 *
 * Used in TWO places that MUST stay in sync:
 *   1. `app.enableCors({ origin })` in main.ts — controls which cross-origin
 *      responses the browser is allowed to READ.
 *   2. `CsrfMiddleware` — actively BLOCKS state-changing requests whose Origin/
 *      Referer isn't trusted (CORS alone does not stop the request from executing
 *      server-side, so it is not a CSRF defense on its own).
 *
 * Keeping one list avoids the classic drift bug where CORS and CSRF disagree and
 * either break legitimate clients or leave a hole.
 */
export function buildAllowedOrigins(config: ConfigService<EnvVariables>): (string | RegExp)[] {
   const configured =
      config
         .get("this-service.frontend_url", { infer: true })
         ?.split(",")
         .map((s) => s.trim())
         .filter(Boolean) ?? [];

   return [
      ...configured,
      /\.shadijiha\.com$/,
      "http://shadijiha.com",
      "https://shadijiha.com",
      /https?:\/\/(.+\.)?shadijiha\.com$/,
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
      /^http:\/\/localhost:\d+$/,
      /^capacitor:\/\//,
   ];
}

/** Whether a concrete origin string is trusted by the allow-list. */
export function isOriginAllowed(origin: string, allowed: (string | RegExp)[]): boolean {
   return allowed.some((entry) =>
      typeof entry === "string" ? entry === origin : entry.test(origin),
   );
}
