import { Inject, Logger } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { ReplicaLinkRegistry } from "./replica-link.registry";
import { REPLICA_LINK_NAMESPACE, type ReplicaLinkAuth } from "./replica-link.constants";

/**
 * Master-side endpoint of the replica-link. Replicas connect here (outbound from their
 * side, so NAT/tunnel is not a problem) and are tracked in ReplicaLinkRegistry. The
 * connection is authenticated with the shared cross-service secret; unauthenticated
 * sockets are dropped immediately.
 *
 * On a replica node this gateway is still instantiated but simply never receives
 * connections (the replica isn't publicly reachable) — harmless.
 */
@WebSocketGateway({
   namespace: REPLICA_LINK_NAMESPACE,
   cors: { origin: true, credentials: true },
})
export class ReplicationGateway implements OnGatewayConnection, OnGatewayDisconnect {
   private readonly logger = new Logger(ReplicationGateway.name);

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly registry: ReplicaLinkRegistry,
   ) {}

   handleConnection(client: Socket): void {
      const auth = (client.handshake.auth ?? {}) as Partial<ReplicaLinkAuth>;
      const expected = this.config.get("cross-service.secret", { infer: true });

      if (!auth.token || auth.token !== expected) {
         this.logger.warn(`Rejected replica-link connection ${client.id}: bad or missing token`);
         client.disconnect();
         return;
      }

      const ip =
         (client.handshake.headers["cf-connecting-ip"] as string) ||
         (client.handshake.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
         client.handshake.address;
      const mirrorDirs = Number.isFinite(Number(auth.mirrorDirs)) ? Number(auth.mirrorDirs) : 0;

      this.registry.register(client, ip, mirrorDirs);
   }

   handleDisconnect(client: Socket): void {
      this.registry.unregister(client.id);
   }
}
