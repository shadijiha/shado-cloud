import { Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type NextFunction, type Request, type Response } from "express";
import { EnvVariables } from "./config/config.validator";
import { buildAllowedOrigins, isOriginAllowed } from "./allowed-origins";

/**
 * CSRF protection via Origin/Referer allow-listing.
 *
 * Why this is needed: auth is a cookie the browser attaches automatically to
 * every request to this API, and in prod the cookie is `SameSite=None` (so the
 * native app can use it cross-site). That means the browser's own CSRF defense
 * is effectively off, and any website could trigger authenticated
 * POST/PUT/PATCH/DELETE calls with the victim's cookie. CORS does NOT stop this:
 * it only hides the response, the request still runs on the server.
 *
 * Strategy (applied only to state-changing methods):
 *   - Safe methods (GET/HEAD/OPTIONS) are never CSRF vectors -> allow.
 *   - Trusted service-to-service calls carry the shared `x-service-key`. A browser
 *     cannot set that custom header cross-site (it would trigger a CORS preflight
 *     that fails), so its presence+match proves the caller isn't a forged browser
 *     request -> allow.
 *   - Otherwise resolve the request's browser origin (Origin header, falling back
 *     to the Referer's origin). Browsers ALWAYS send one of these on a cross-origin
 *     unsafe request, so:
 *       * no Origin AND no Referer  => non-browser client (server-to-server,
 *         curl, GitHub webhook, ...) which can't be driven by a victim's browser
 *         -> allow.
 *       * origin present & trusted  -> allow.
 *       * origin present & untrusted -> 403.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
   private static readonly SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
   private readonly allowedOrigins: (string | RegExp)[];
   private readonly serviceKey?: string;

   constructor(private readonly config: ConfigService<EnvVariables>) {
      this.allowedOrigins = buildAllowedOrigins(config);
      this.serviceKey = config.get("cross-service.secret", { infer: true });
   }

   use(req: Request, res: Response, next: NextFunction) {
      if (CsrfMiddleware.SAFE_METHODS.has((req.method || "").toUpperCase())) return next();

      // Trusted service-to-service call.
      const serviceKey = req.headers["x-service-key"];
      if (typeof serviceKey === "string" && this.serviceKey && serviceKey === this.serviceKey) {
         return next();
      }

      const origin = this.resolveOrigin(req);
      // Non-browser client (no ambient-cookie CSRF risk).
      if (!origin) return next();

      if (isOriginAllowed(origin, this.allowedOrigins)) return next();

      // Write the response directly: exceptions thrown from Express-layer middleware are
      // not reliably routed through Nest's exception filters, so throwing here could
      // surface as a 500. A direct 403 is deterministic.
      res.status(403).json({ statusCode: 403, error: "Forbidden", message: "Request blocked by CSRF origin check" });
   }

   /** Origin header, else the origin component of the Referer, else null. */
   private resolveOrigin(req: Request): string | null {
      const origin = req.headers["origin"];
      if (typeof origin === "string" && origin) return origin;

      const referer = req.headers["referer"];
      if (typeof referer === "string" && referer) {
         try {
            return new URL(referer).origin;
         } catch {
            return null;
         }
      }
      return null;
   }
}
