import { Inject, Logger } from "@nestjs/common";
import {
   ConnectedSocket,
   MessageBody,
   OnGatewayConnection,
   OnGatewayDisconnect,
   SubscribeMessage,
   WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { ReplicaLinkRegistry } from "./replica-link.registry";
import {
   REPLICA_DEPLOY_OUTPUT_EVENT,
   REPLICA_DEPLOY_RESULT_EVENT,
   REPLICA_DEPLOY_STEP_EVENT,
   REPLICA_LINK_NAMESPACE,
   type ReplicaDeployOutput,
   type ReplicaDeployResult,
   type ReplicaDeployStepUpdate,
} from "./replica-link.constants";
import { verifyServiceHmac } from "src/auth/service-auth.util";
import { ReplicaDeploymentCoordinator } from "./replica-deployment.coordinator";

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
      private readonly deployments: ReplicaDeploymentCoordinator,
   ) {}

   handleConnection(client: Socket): void {
      const auth = (client.handshake.auth ?? {}) as Record<string, unknown>;
      const expected = this.config.get("cross-service.secret", { infer: true });

      // Same HMAC scheme as ServiceKeyGuard: a time-bound (5 min), nonce'd signature over
      // an empty body. The raw secret is never transmitted — a captured handshake can't be
      // replayed beyond the window.
      if (!verifyServiceHmac(expected, auth as Record<string, any>, "")) {
         this.logger.warn(`Rejected replica-link connection ${client.id}: invalid service signature`);
         client.disconnect();
         return;
      }

      const ip =
         (client.handshake.headers["cf-connecting-ip"] as string) ||
         (client.handshake.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
         client.handshake.address;
      const deviceName = typeof auth.deviceName === "string" && auth.deviceName.trim() ? auth.deviceName.trim() : "unknown";
      const mirrorDirs = Number.isFinite(Number(auth.mirrorDirs)) ? Number(auth.mirrorDirs) : 0;

      // Stash the verified identity on the socket. Deployment reports arrive on an
      // already-authenticated connection, and deriving identity from the handshake
      // rather than the message body stops a replica claiming to be another one.
      client.data.replica = { ip, deviceName };

      this.registry.register(client, ip, deviceName, mirrorDirs);
   }

   handleDisconnect(client: Socket): void {
      this.registry.unregister(client.id);
   }

   /* ── deployment reports (replica → master) ─────────────────────────────────
    * The socket is trusted after the HMAC handshake, so these carry no signature
    * of their own. Identity always comes from `client.data`, never the payload.
    * ──────────────────────────────────────────────────────────────────────── */

   @SubscribeMessage(REPLICA_DEPLOY_OUTPUT_EVENT)
   handleDeployOutput(@ConnectedSocket() client: Socket, @MessageBody() payload: ReplicaDeployOutput): void {
      const identity = this.identify(client);
      if (!identity) return;
      this.deployments.handleOutput(identity, payload);
   }

   @SubscribeMessage(REPLICA_DEPLOY_STEP_EVENT)
   handleDeployStep(@ConnectedSocket() client: Socket, @MessageBody() payload: ReplicaDeployStepUpdate): void {
      const identity = this.identify(client);
      if (!identity) return;
      this.deployments.handleStep(identity, payload);
   }

   @SubscribeMessage(REPLICA_DEPLOY_RESULT_EVENT)
   handleDeployResult(@ConnectedSocket() client: Socket, @MessageBody() payload: ReplicaDeployResult): void {
      const identity = this.identify(client);
      if (!identity) return;
      this.deployments.handleResult(identity, payload);
   }

   /** The identity established at handshake time, or null if somehow absent. */
   private identify(client: Socket): { ip: string; deviceName: string } | null {
      const identity = client.data?.replica as { ip: string; deviceName: string } | undefined;
      if (!identity) {
         this.logger.warn(`Deploy report from socket ${client.id} with no verified identity; ignoring`);
         return null;
      }
      return identity;
   }
}
