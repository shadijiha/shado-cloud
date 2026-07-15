import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { verifyServiceHmac } from "./service-auth.util";

/**
 * Allows a request when it carries a valid per-request HMAC signature proving possession of
 * the shared cross-service secret (x-service-timestamp / x-service-nonce / x-service-signature;
 * see service-auth.util). Used for trusted service-to-service calls (feature-flag reads,
 * replication between cloud instances) without an admin session.
 *
 * The signature is time-bound and tamper-evident, replacing the old replayable static
 * `x-service-key` header. All service callers sign their requests, so the legacy static key is
 * no longer accepted over HTTP. (TCP microservice calls still authenticate with the shared key
 * in their payload — a separate transport.)
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
   constructor(private readonly config: ConfigService<EnvVariables>) {}

   canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const expected = this.config.get("cross-service.secret", { infer: true });
      // rawBody is captured by the json body-parser hook (empty for GET => signed over "").
      return verifyServiceHmac(expected, req.headers, req.rawBody);
   }
}
