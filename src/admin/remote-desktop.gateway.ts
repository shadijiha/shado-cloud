import {
   Inject,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
   WebSocketGateway,
   WebSocketServer,
   SubscribeMessage,
   OnGatewayConnection,
   OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { exec, ChildProcess } from "child_process";
import { promisify } from "util";
import { AuthService } from "../auth/auth.service";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { LoggerToDb } from "../logging";
import { DisplayStrategy, DisplayStrategyFactory } from "./display-strategy";
import { FeatureFlagService } from "./feature-flag.service";
import { REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY } from "./remote.constants";

const execAsync = promisify(exec);

interface MouseEvent {
   x: number;
   y: number;
   button?: number; // 1=left, 2=middle, 3=right
   type: "move" | "click" | "scroll" | "mousedown" | "mouseup";
   scrollY?: number;
}

interface KeyEvent {
   key: string;
   type: "down" | "up";
}

@WebSocketGateway({
   namespace: "/remote-desktop",
   cors: { origin: true, credentials: true },
})
export class RemoteDesktopGateway implements OnGatewayConnection, OnGatewayDisconnect {
   @WebSocketServer()
   server: Server;

   private streamInterval: NodeJS.Timeout | null = null;
   private ffmpegProcess: ChildProcess | null = null;
   private connectedClients = 0;
   private readonly display: DisplayStrategy;

   /** Maps connected socket → owning shadoUserId, for grant expiry sweeps. */
   private readonly clientUsers = new Map<string, { userId: string; socket: Socket }>();

   constructor(
      private authService: AuthService,
      @Inject() private readonly logger: LoggerToDb,
      private readonly featureFlags: FeatureFlagService,
   ) {
      this.display = DisplayStrategyFactory.create();
      this.logger.log(`RemoteDesktopGateway initialized with ${this.display.name} display strategy`);
   }

   async handleConnection(client: Socket) {
      let userId: string | null = null;
      try {
         const rawCookies = client.handshake.headers.cookie || "";
         if (!rawCookies) {
            this.logger.warn(`Unauthorized connection attempt: ${client.id} - no session`);
            client.disconnect();
            return;
         }
         userId = await this.authService.validateCookies(rawCookies);
         if (!userId) {
            this.logger.warn(`Unauthorized connection attempt: ${client.id} - invalid token`);
            client.disconnect();
            return;
         }
         const isAdmin = await this.authService.isAdmin(userId);
         if (!isAdmin) {
            this.logger.warn(`Unauthorized connection attempt: ${client.id} - not admin`);
            client.disconnect();
            return;
         }
      } catch {
         this.logger.warn(`Unauthorized connection attempt: ${client.id} - auth failed`);
         client.disconnect();
         return;
      }

      // Gated behind the shared remote-access feature flag (disabled by default). Fail closed.
      try {
         if (await this.featureFlags.isFeatureFlagDisabled(REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY)) {
            this.logger.warn(`Remote desktop connection rejected (feature flag disabled): ${client.id}`);
            client.disconnect();
            return;
         }
      } catch {
         this.logger.warn(`Remote desktop flag check failed, rejecting: ${client.id}`);
         client.disconnect();
         return;
      }

      // Require a valid 2FA remote-access grant (60-minute window). Fail closed.
      try {
         if (!(await this.authService.hasStepUp(userId, "remote"))) {
            this.logger.warn(`Remote desktop connection rejected (no 2FA grant): ${client.id}`);
            client.emit("denied", "Remote access requires 2FA verification.");
            client.disconnect();
            return;
         }
      } catch {
         this.logger.warn(`Remote desktop grant check failed, rejecting: ${client.id}`);
         client.disconnect();
         return;
      }

      this.clientUsers.set(client.id, { userId, socket: client });
      this.connectedClients++;
      this.logger.log(`Admin client connected: ${client.id}, total: ${this.connectedClients}`);

      try {
         const screenInfo = await this.display.getScreenInfo();
         client.emit("screen-info", screenInfo);
      } catch {
         this.logger.warn("Could not get screen resolution, using defaults");
         client.emit("screen-info", { width: 1920, height: 1080 });
      }

      if (this.connectedClients === 1) {
         this.startStreaming();
      }
   }

   handleDisconnect(client: Socket) {
      this.clientUsers.delete(client.id);
      this.connectedClients--;
      this.logger.log(`Client disconnected: ${client.id}, total: ${this.connectedClients}`);

      if (this.connectedClients === 0) {
         this.stopStreaming();
      }
   }

   /** Disconnect any client whose remote-access grant has expired. */
   @Cron(CronExpression.EVERY_30_SECONDS)
   private async sweepExpiredGrants() {
      for (const [clientId, entry] of this.clientUsers) {
         try {
            if (await this.authService.hasStepUp(entry.userId, "remote")) continue;
            this.logger.warn(`Remote desktop session expired (grant lapsed): ${clientId}`);
            entry.socket.emit("denied", "Remote access grant expired.");
            entry.socket.disconnect();
         } catch (err) {
            this.logger.error(`Remote desktop grant sweep failed for ${clientId}: ${(err as Error)?.message}`);
         }
      }
   }

   private startStreaming() {
      this.logger.log("Starting WebRTC stream via mediamtx");
      const webrtcUrl = this.display.getStreamUrl();
      if (webrtcUrl) {
         this.server.emit("webrtc-url", webrtcUrl);
      }
      this.startMjpegFallback();
   }

   private startMjpegFallback() {
      const captureCmd = this.display.getScreenshotCommand();
      const mime = this.display.getScreenshotMimeType();
      this.streamInterval = setInterval(async () => {
         try {
            const { stdout } = await execAsync(captureCmd, { maxBuffer: 10 * 1024 * 1024, timeout: 1000 });
            this.server.emit("frame", `data:${mime};base64,${stdout.trim()}`);
         } catch {
            // Silent fail - WebRTC might be working
         }
      }, 500);
   }

   private stopStreaming() {
      if (this.ffmpegProcess) {
         this.ffmpegProcess.kill();
         this.ffmpegProcess = null;
      }
      if (this.streamInterval) {
         clearInterval(this.streamInterval);
         this.streamInterval = null;
      }
      this.logger.log("Stopped screen stream");
   }

   @SubscribeMessage("mouse")
   async handleMouse(client: Socket, event: MouseEvent) {
      try {
         const x = Math.round(event.x);
         const y = Math.round(event.y);

         if (event.type === "move") {
            await this.display.mouseMove(x, y);
         } else if (event.type === "click") {
            await this.display.mouseClick(x, y, event.button || 1);
         } else if (event.type === "mousedown") {
            await this.display.mouseDown(x, y, event.button || 1);
         } else if (event.type === "mouseup") {
            await this.display.mouseUp(x, y, event.button || 1);
         } else if (event.type === "scroll") {
            await this.display.mouseScroll(x, y, event.scrollY || 0);
         }
      } catch (err) {
         this.logger.error("Mouse event failed: " + (err as Error).message);
      }
   }

   @SubscribeMessage("key")
   async handleKey(client: Socket, event: KeyEvent) {
      try {
         if (event.type === "down") {
            const isSpecialKey = event.key.length > 1 || event.key === " ";
            if (isSpecialKey) {
               await this.display.keyPress(event.key);
            } else {
               await this.display.typeChar(event.key);
            }
         }
      } catch (err) {
         this.logger.error("Key event failed: " + (err as Error).message);
      }
   }
}
