import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * ThrottlerGuard that rate-limits by the REAL client IP.
 *
 * The default guard keys on `req.ip`, which — behind Cloudflare / a reverse proxy and
 * without `trust proxy` — is the edge/proxy IP. That would put every user in the SAME
 * bucket, so any limit would throttle the whole userbase collectively (or, conversely,
 * let one abuser hide among everyone).
 *
 * We therefore prefer Cloudflare's `cf-connecting-ip` (set by CF, not spoofable by the
 * client) and fall back to `req.ip` when it's absent (direct/dev/LAN). We deliberately do
 * NOT trust `x-forwarded-for` for throttling: unlike cf-connecting-ip it can be forged by
 * the client, which would let an attacker rotate fake values to evade the limit.
 */
@Injectable()
export class RealIpThrottlerGuard extends ThrottlerGuard {
   protected async getTracker(req: Record<string, any>): Promise<string> {
      const cf = req.headers?.["cf-connecting-ip"];
      if (typeof cf === "string" && cf.length > 0) return cf.split(",")[0].trim();
      return req.ip;
   }
}
