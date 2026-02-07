import {
   Inject,
} from "@nestjs/common";
import {
   WebSocketGateway,
   WebSocketServer,
   SubscribeMessage,
   OnGatewayConnection,
   OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { exec } from "child_process";
import { promisify } from "util";
import { Logger } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import * as cookie from "cookie";
import * as jwt from "jsonwebtoken";
import { CookiePayload } from "../auth/authApiTypes";
import { LoggerToDb } from "../logging";

const execAsync = promisify(exec);

interface MouseEvent {
   x: number;
   y: number;
   button?: number; // 1=left, 2=middle, 3=right
   type: "move" | "click" | "scroll";
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
   private connectedClients = 0;
   private screenWidth = 1920;
   private screenHeight = 1080;

   constructor(
      private authService: AuthService,
      private config: ConfigService<EnvVariables>,
    @Inject() private readonly logger: LoggerToDb,
   ) {
           this.logger.log("RemoteDesktopGateway initialized");
   }

   async handleConnection(client: Socket) {
      // Verify admin authentication via JWT
      try {
         const cookies = cookie.parse(client.handshake.headers.cookie || "");
         const token = cookies[this.config.get("COOKIE_NAME")!];
         if (!token) {
            this.logger.warn(`Unauthorized connection attempt: ${client.id} - no session`);
            client.disconnect();
            return;
         }
         const payload = jwt.verify(token, this.config.get("JWT_SECRET")!) as CookiePayload;
         const user = await this.authService.getById(payload.userId);
         if (!user || !user.is_admin) {
            this.logger.warn(`Unauthorized connection attempt: ${client.id} - not admin`);
            client.disconnect();
            return;
         }
      } catch {
         this.logger.warn(`Unauthorized connection attempt: ${client.id} - auth failed`);
         client.disconnect();
         return;
      }

      this.connectedClients++;
      this.logger.log(`Admin client connected: ${client.id}, total: ${this.connectedClients}`);

      // Get screen resolution
      try {
         const { stdout } = await execAsync("xdpyinfo | grep dimensions | awk '{print $2}'");
         const [w, h] = stdout.trim().split("x").map(Number);
         if (w && h) {
            this.screenWidth = w;
            this.screenHeight = h;
         }
      } catch {
         this.logger.warn("Could not get screen resolution, using defaults");
      }

      client.emit("screen-info", { width: this.screenWidth, height: this.screenHeight });

      if (this.connectedClients === 1) {
         this.startStreaming();
      }
   }

   handleDisconnect(client: Socket) {
      this.connectedClients--;
      this.logger.log(`Client disconnected: ${client.id}, total: ${this.connectedClients}`);

      if (this.connectedClients === 0) {
         this.stopStreaming();
      }
   }

   private startStreaming() {
      this.logger.log("Starting screen stream");
      const env = this.execEnv;
      this.logger.log(JSON.stringify(env));
      
      this.streamInterval = setInterval(async () => { 
        try {
            const { stdout } = await execAsync(
              "scrot -p -o /tmp/screen.jpg -q 70 && base64 /tmp/screen.jpg",
              { maxBuffer: 10 * 1024 * 1024, env },
            );
            this.server.emit("frame", `data:image/jpeg;base64,${stdout.trim()}`);
         } catch (err) {
            this.logger.error("Screen capture failed: " + (err as Error).message);
         }
      }, 200); // ~5 FPS
   }

   private stopStreaming() {
      if (this.streamInterval) {
         clearInterval(this.streamInterval);
         this.streamInterval = null;
         this.logger.log("Stopped screen stream");
      }
   }

   private get execEnv() {
      // Try user session first, fall back to gdm
      const xauth = process.env.XAUTHORITY || `/home/shadi/.Xauthority`;
      return {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        XAUTHORITY: xauth,
      };
   }

   @SubscribeMessage("mouse")
   async handleMouse(client: Socket, event: MouseEvent) {
      try {
         const x = Math.round(event.x);
         const y = Math.round(event.y);
         this.logger.debug(`Mouse event: ${event.type} at ${x},${y}`);
         if (event.type === "move") {
            await execAsync(`xdotool mousemove ${x} ${y}`, { env: this.execEnv });
         } else if (event.type === "click") {
            const button = event.button || 1;
            await execAsync(`xdotool mousemove ${x} ${y} click ${button}`, { env: this.execEnv });
         } else if (event.type === "scroll") {
            const direction = (event.scrollY || 0) > 0 ? 5 : 4; // 4=up, 5=down
            await execAsync(`xdotool mousemove ${x} ${y} click ${direction}`, { env: this.execEnv });
         }
      } catch (err) {
         this.logger.error("Mouse event failed", err);
      }
   }

   @SubscribeMessage("key")
   async handleKey(client: Socket, event: KeyEvent) {
      try {
         const key = this.mapKey(event.key);
         // Only handle keydown to avoid double input
         if (event.type === "down") {
            if (key.length === 1 && !event.key.startsWith("Arrow")) {
               // Regular character - use type
               await execAsync(`xdotool type --clearmodifiers "${key}"`, { env: this.execEnv });
            } else {
               // Special key - use key
               await execAsync(`xdotool key ${key}`, { env: this.execEnv });
            }
         }
      } catch (err) {
         this.logger.error("Key event failed", err);
      }
   }

   private mapKey(key: string): string {
      const keyMap: Record<string, string> = {
         " ": "space",
         Enter: "Return",
         Backspace: "BackSpace",
         Tab: "Tab",
         Escape: "Escape",
         ArrowUp: "Up",
         ArrowDown: "Down",
         ArrowLeft: "Left",
         ArrowRight: "Right",
         Shift: "shift",
         Control: "ctrl",
         Alt: "alt",
         Meta: "super",
         Delete: "Delete",
         Home: "Home",
         End: "End",
         PageUp: "Page_Up",
         PageDown: "Page_Down",
      };
      return keyMap[key] || key;
   }
}
