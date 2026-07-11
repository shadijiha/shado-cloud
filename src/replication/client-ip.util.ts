import { Request } from "express";

/** Strips the IPv4-mapped IPv6 prefix and trims. */
export function normalizeIp(ip?: string): string {
   return (ip ?? "").replace("::ffff:", "").trim();
}

/**
 * Resolves the real client IP.
 *
 * Behind a Cloudflare tunnel, cloudflared runs on the same host and proxies to the app
 * on loopback, so req.socket.remoteAddress is always 127.0.0.1/::1 and the true client
 * IP is in the `CF-Connecting-IP` header. We only trust that header when the socket is
 * actually loopback (i.e. the request really came from the local tunnel); otherwise a
 * direct client could spoof it.
 */
export function resolveClientIp(req: Request): string {
   const socketIp = normalizeIp(req.socket.remoteAddress);
   const isFromLocalTunnel = socketIp === "127.0.0.1" || socketIp === "::1";
   const cfIp = req.headers["cf-connecting-ip"];
   if (isFromLocalTunnel && typeof cfIp === "string" && cfIp.trim()) {
      return normalizeIp(cfIp);
   }
   return normalizeIp(req.ip || req.socket.remoteAddress);
}
