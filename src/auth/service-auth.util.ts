import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { ReadPacket, Serializer } from "@nestjs/microservices";

/**
 * HMAC signing/verification for service-to-service HTTP calls.
 *
 * The legacy scheme sent a static shared secret in `x-service-key`. If that header is ever
 * captured (logs, a proxy, a mirrored request) it can be replayed forever. This upgrades it
 * to a per-request HMAC signature that is:
 *   - time-bound (a timestamp within SERVICE_AUTH_WINDOW_MS), so a captured signature only
 *     works for a few minutes, and
 *   - tamper-evident on the body (the signature covers a SHA-256 of the request body).
 *
 * The signed payload is `v1.{timestamp}.{nonce}.{sha256(body)}`. We intentionally do NOT bind
 * the HTTP method/path: `getfile/:path` carries URL-encoded slashes that make path
 * canonicalisation fragile across sender/receiver, and the single shared secret already
 * authorises every service endpoint, so path-binding would add no privilege separation.
 *
 * Rollout is backward-compatible: signers still send `x-service-key`, and receivers accept a
 * valid HMAC OR (unless `require-hmac` is enabled) the legacy key.
 */

export const SERVICE_AUTH_HEADERS = {
   timestamp: "x-service-timestamp",
   nonce: "x-service-nonce",
   signature: "x-service-signature",
} as const;

/** Max allowed request age / clock skew for a signed request (5 minutes). */
export const SERVICE_AUTH_WINDOW_MS = 5 * 60_000;

function sha256Hex(body?: string | Buffer): string {
   return createHash("sha256").update(body ?? "").digest("hex");
}

function computeSignature(secret: string, timestamp: string, nonce: string, body?: string | Buffer): string {
   const canonical = `v1.${timestamp}.${nonce}.${sha256Hex(body)}`;
   return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Headers that authenticate a service-to-service HTTP call. Includes the legacy
 * `x-service-key` so receivers that haven't enabled HMAC enforcement still accept the call.
 */
export function signServiceHeaders(secret: string, body?: string | Buffer): Record<string, string> {
   const timestamp = Date.now().toString();
   const nonce = randomBytes(16).toString("hex");
   return {
      "x-service-key": secret,
      [SERVICE_AUTH_HEADERS.timestamp]: timestamp,
      [SERVICE_AUTH_HEADERS.nonce]: nonce,
      [SERVICE_AUTH_HEADERS.signature]: computeSignature(secret, timestamp, nonce, body),
   };
}

/** Whether HMAC signature headers are present (distinguishes "no HMAC" from "bad HMAC"). */
export function hasServiceHmac(headers: Record<string, any>): boolean {
   return (
      typeof headers?.[SERVICE_AUTH_HEADERS.timestamp] === "string" &&
      typeof headers?.[SERVICE_AUTH_HEADERS.nonce] === "string" &&
      typeof headers?.[SERVICE_AUTH_HEADERS.signature] === "string"
   );
}

/** Whether the request carries a well-formed, fresh, correct HMAC signature. */
export function verifyServiceHmac(
   secret: string,
   headers: Record<string, any>,
   body?: string | Buffer,
   now: number = Date.now(),
): boolean {
   if (!secret || !hasServiceHmac(headers)) return false;

   const timestamp = headers[SERVICE_AUTH_HEADERS.timestamp] as string;
   const nonce = headers[SERVICE_AUTH_HEADERS.nonce] as string;
   const signature = headers[SERVICE_AUTH_HEADERS.signature] as string;

   const ts = Number(timestamp);
   if (!Number.isFinite(ts) || Math.abs(now - ts) > SERVICE_AUTH_WINDOW_MS) return false;

   const expected = computeSignature(secret, timestamp, nonce, body);
   const provided = Buffer.from(signature, "hex");
   const expectedBuf = Buffer.from(expected, "hex");
   // timingSafeEqual throws on length mismatch; guard it (and reject empty/odd hex).
   if (provided.length === 0 || provided.length !== expectedBuf.length) return false;
   return timingSafeEqual(provided, expectedBuf);
}

// ─── TCP microservice signing ────────────────────────────────────────────────
// The TCP transport carries auth as an `__svcAuth` envelope inside the message payload
// (there are no headers). Signing is applied automatically by SignedServiceSerializer on the
// client, and verified by the global RPC guard on the server. Same HMAC/timestamp/nonce scheme
// and 5-minute window as the HTTP path.

/**
 * Deterministic JSON with recursively sorted keys, so the signer and verifier produce the same
 * canonical string regardless of property order over the wire.
 */
export function stableStringify(value: any): string {
   if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
   if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
   const keys = Object.keys(value).sort();
   return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Attach an HMAC auth envelope (`__svcAuth`) to an outgoing TCP message payload. */
export function signServicePayload<T extends Record<string, any>>(
   secret: string,
   payload: T,
): T & { __svcAuth: { t: string; n: string; s: string } } {
   const body = (payload ?? {}) as T;
   const t = Date.now().toString();
   const n = randomBytes(16).toString("hex");
   const s = createHmac("sha256", secret).update(`v1.${t}.${n}.${sha256Hex(stableStringify(body))}`).digest("hex");
   return { ...body, __svcAuth: { t, n, s } };
}

/** Verify the `__svcAuth` envelope on an incoming TCP message payload. */
export function verifyServicePayload(secret: string, data: any, now: number = Date.now()): boolean {
   if (!secret || !data || typeof data !== "object") return false;
   const auth = data.__svcAuth;
   if (!auth || typeof auth.t !== "string" || typeof auth.n !== "string" || typeof auth.s !== "string") return false;
   const ts = Number(auth.t);
   if (!Number.isFinite(ts) || Math.abs(now - ts) > SERVICE_AUTH_WINDOW_MS) return false;
   const rest: Record<string, any> = { ...data };
   delete rest.__svcAuth;
   const expected = createHmac("sha256", secret).update(`v1.${auth.t}.${auth.n}.${sha256Hex(stableStringify(rest))}`).digest("hex");
   const provided = Buffer.from(auth.s, "hex");
   const expectedBuf = Buffer.from(expected, "hex");
   if (provided.length === 0 || provided.length !== expectedBuf.length) return false;
   return timingSafeEqual(provided, expectedBuf);
}

/** ClientProxy serializer that auto-signs every outgoing TCP message's payload. */
export class SignedServiceSerializer implements Serializer {
   constructor(private readonly secret: string) {}
   serialize(value: ReadPacket): any {
      return { ...value, data: signServicePayload(this.secret, (value?.data ?? {}) as Record<string, any>) };
   }
}
