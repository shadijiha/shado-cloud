import { Inject, Logger } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { ReplicaLinkRegistry } from "./replica-link.registry";
import { ReplicaDeployHub } from "./replica-deploy-hub.service";
import {
   REPLICA_LINK_NAMESPACE,
   DEPLOY_OUTPUT_EVENT,
   DEPLOY_STEP_EVENT,
   DEPLOY_COMPLETE_EVENT,
   type DeployOutputMsg,
   type DeployStepMsg,
   type DeployCompleteMsg,
} from "./replica-link.constants";
import { verifyServiceHmac } from "src/auth/service-auth.util";

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
      private readonly deployHub: ReplicaDeployHub,
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

      this.registry.register(client, ip, deviceName, mirrorDirs);

      // Relay this replica's deploy progress into the master-side hub (which the admin UI
      // streams over SSE). The replica only sends its deployId/step/output; we enrich each
      // event with the master-known identity (socket id + resolved IP + device name).
      client.on(DEPLOY_OUTPUT_EVENT, (msg: DeployOutputMsg) => {
         if (!msg) return;
         this.deployHub.output(client.id, ip, deviceName, msg.deployId, msg.step, msg.output ?? "");
      });
      client.on(DEPLOY_STEP_EVENT, (msg: DeployStepMsg) => {
         if (!msg) return;
         this.deployHub.step(client.id, ip, deviceName, msg.deployId, msg.step, msg.name, msg.status, msg.error);
      });
      client.on(DEPLOY_COMPLETE_EVENT, (msg: DeployCompleteMsg) => {
         if (!msg) return;
         this.deployHub.complete(client.id, ip, deviceName, msg.deployId, msg.project, msg.status, msg.error);
      });
   }

   handleDisconnect(client: Socket): void {
      this.registry.unregister(client.id);
   }
}
