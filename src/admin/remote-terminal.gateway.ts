import { Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
   WebSocketGateway,
   WebSocketServer,
   SubscribeMessage,
   MessageBody,
   ConnectedSocket,
   OnGatewayConnection,
   OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import * as os from "os";
import * as fs from "fs";
import { AuthService } from "../auth/auth.service";
import { FeatureFlagService } from "./feature-flag.service";
import { REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY } from "./remote.constants";

/** Minimal shape of the bits of node-pty we use (avoids a compile-time dep). */
interface IPty {
   onData(cb: (data: string) => void): void;
   onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
   write(data: string): void;
   resize(cols: number, rows: number): void;
   kill(signal?: string): void;
}
interface NodePty {
   spawn(file: string, args: string[], options: Record<string, unknown>): IPty;
}

/**
 * Full interactive terminal backed by a real PTY (node-pty).
 *
 * Each socket gets its own persistent shell, so interactive programs
 * (sudo password prompts, vim, top), colours, and a persistent working
 * directory all work.
 *
 * node-pty is a native module; it is require()'d lazily inside a try/catch so
 * that a failed/missing build can NEVER stop the Nest process from booting —
 * the terminal feature simply becomes unavailable. Every handler is likewise
 * wrapped so nothing here can crash the process; at worst a single session dies.
 */
let pty: NodePty | null = null;
try {
   // eslint-disable-next-line @typescript-eslint/no-var-requires
   pty = require("node-pty") as NodePty;
} catch {
   pty = null;
}

interface ResizeEvent {
   cols: number;
   rows: number;
}

@WebSocketGateway({
   namespace: "/remote-terminal",
   cors: { origin: true, credentials: true },
})
export class RemoteTerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
   @WebSocketServer()
   server: Server;

   /** One PTY shell per connected admin socket, tagged with the owning user. */
   private readonly sessions = new Map<string, { term: IPty; userId: string; socket: Socket }>();

   private readonly logger = new Logger(RemoteTerminalGateway.name);

   constructor(
      private authService: AuthService,
      private readonly featureFlags: FeatureFlagService,
   ) {
      if (!pty) {
         this.safeLog("warn", "node-pty not available — terminal sessions will be rejected");
      } else {
         this.safeLog("log", "RemoteTerminalGateway initialized (node-pty)");
      }
   }

   /** Validate cookies + admin. Returns the shadoUserId, or null if not allowed. */
   private async authenticate(client: Socket): Promise<string | null> {
      try {
         const rawCookies = client.handshake.headers.cookie || "";
         if (!rawCookies) return null;
         const userId = await this.authService.validateCookies(rawCookies);
         if (!userId) return null;
         if (!(await this.authService.isAdmin(userId))) return null;
         return userId;
      } catch {
         return null;
      }
   }

   /** Pick an interactive shell that actually exists on this host. */
   private resolveShell(): string {
      if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
      const candidates = [process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/bin/sh"].filter(
         Boolean,
      ) as string[];
      for (const sh of candidates) {
         try {
            if (fs.existsSync(sh)) return sh;
         } catch {
            /* ignore */
         }
      }
      return "/bin/sh";
   }

   /**
    * Builds a clean, SSH-like environment for the terminal. Only a small whitelist of
    * generic vars is carried over from the host; the API process's application config and
    * secrets (DB_*, FRONTEND_URL, cross-service secrets, etc.) are intentionally excluded
    * so they never leak into the shell or any process spawned from it. The login shell
    * then populates the rest from the user's own profile.
    */
   private buildShellEnv(shell: string): { [key: string]: string } {
      const allow = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
      const env: { [key: string]: string } = {};
      for (const key of allow) {
         const value = process.env[key];
         if (value) env[key] = value;
      }
      if (!env.PATH) env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
      env.SHELL = shell;
      env.TERM = "xterm-256color";
      env.COLORTERM = "truecolor";
      return env;
   }

   async handleConnection(client: Socket) {
      try {
         const userId = await this.authenticate(client);
         if (!userId) {
            this.safeLog("warn", `Unauthorized terminal connection attempt: ${client.id}`);
            client.disconnect();
            return;
         }

         // Gated behind a feature flag (disabled by default). Fail closed.
         if (await this.featureFlags.isFeatureFlagDisabled(REMOTE_FLAG_NAMESPACE, REMOTE_FLAG_KEY)) {
            this.safeLog("warn", `Terminal connection rejected (feature flag disabled): ${client.id}`);
            this.emitSafe(
               client,
               "output",
               "\r\n\x1b[33mThe remote terminal is currently disabled by a feature flag.\x1b[0m\r\n",
            );
            client.disconnect();
            return;
         }

         // Require a valid 2FA remote-access grant (60-minute window). Fail closed.
         if (!(await this.authService.hasStepUp(userId, "remote"))) {
            this.safeLog("warn", `Terminal connection rejected (no 2FA grant): ${client.id}`);
            this.emitSafe(client, "denied", "Remote access requires 2FA verification.");
            this.emitSafe(
               client,
               "output",
               "\r\n\x1b[33mRemote access requires 2FA verification. Enter your code on the Remote page.\x1b[0m\r\n",
            );
            client.disconnect();
            return;
         }

         if (!pty) {
            this.emitSafe(
               client,
               "output",
               "\r\n\x1b[31mTerminal backend unavailable (node-pty not installed).\x1b[0m\r\n",
            );
            client.disconnect();
            return;
         }

         const shell = this.resolveShell();
         const isPosix = process.platform !== "win32";
         let term: IPty;
         try {
            term = pty.spawn(shell, isPosix ? ["-l"] : [], {
               name: "xterm-256color",
               cols: 80,
               rows: 24,
               cwd: process.env.HOME || process.cwd(),
               // A fresh, SSH-like environment. We deliberately do NOT inherit this API
               // process's env: that would leak shado-cloud's secrets/config (DB_PASSWORD,
               // DB_NAME, FRONTEND_URL, ...) into the terminal and into anything started
               // from it (pm2, mysql, deploy scripts) — which silently pointed other
               // services at shado-cloud's database. The login shell (`-l`) sources the
               // user's own profile, just like SSH.
               env: this.buildShellEnv(shell),
            });
         } catch (err) {
            this.safeLog("error", `PTY spawn failed: ${(err as Error)?.message}`);
            this.emitSafe(
               client,
               "output",
               `\r\n\x1b[31mFailed to start shell: ${(err as Error)?.message}\x1b[0m\r\n`,
            );
            client.disconnect();
            return;
         }

         this.sessions.set(client.id, { term, userId, socket: client });
         this.safeLog("log", `Terminal session started: ${client.id} (${shell})`);

         term.onData((data) => this.emitSafe(client, "output", data));

         term.onExit(({ exitCode }) => {
            this.emitSafe(client, "exit", exitCode);
            this.cleanup(client.id);
            try {
               client.disconnect();
            } catch {
               /* ignore */
            }
         });

         this.emitSafe(client, "ready", { host: os.hostname(), shell });
      } catch (err) {
         this.safeLog("error", `handleConnection failed: ${(err as Error)?.message}`);
         try {
            client.disconnect();
         } catch {
            /* ignore */
         }
      }
   }

   handleDisconnect(client: Socket) {
      try {
         this.cleanup(client.id);
         this.safeLog("log", `Terminal session ended: ${client.id}`);
      } catch (err) {
         this.safeLog("error", `handleDisconnect failed: ${(err as Error)?.message}`);
      }
   }

   @SubscribeMessage("input")
   handleInput(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
      try {
         const session = this.sessions.get(client.id);
         if (session && typeof data === "string") {
            session.term.write(data);
         }
      } catch (err) {
         this.safeLog("error", `input failed: ${(err as Error)?.message}`);
      }
   }

   @SubscribeMessage("resize")
   handleResize(@ConnectedSocket() client: Socket, @MessageBody() size: ResizeEvent) {
      try {
         const session = this.sessions.get(client.id);
         if (!session || !size) return;
         const cols = Math.max(1, Math.floor(size.cols) || 80);
         const rows = Math.max(1, Math.floor(size.rows) || 24);
         session.term.resize(cols, rows);
      } catch (err) {
         this.safeLog("error", `resize failed: ${(err as Error)?.message}`);
      }
   }

   /** Disconnect any session whose remote-access grant has expired. */
   @Cron(CronExpression.EVERY_30_SECONDS, { name: "remote-terminal:sweep-grants" })
   private async sweepExpiredGrants() {
      for (const [clientId, session] of this.sessions) {
         try {
            if (await this.authService.hasStepUp(session.userId, "remote")) continue;
            this.safeLog("log", `Terminal session expired (grant lapsed): ${clientId}`);
            const socket = session.socket;
            if (socket) {
               this.emitSafe(
                  socket,
                  "output",
                  "\r\n\x1b[33mRemote access grant expired. Please re-verify 2FA.\x1b[0m\r\n",
               );
               this.emitSafe(socket, "denied", "Remote access grant expired.");
               socket.disconnect();
            }
            this.cleanup(clientId);
         } catch (err) {
            this.safeLog("error", `grant sweep failed for ${clientId}: ${(err as Error)?.message}`);
         }
      }
   }

   private cleanup(clientId: string) {
      const session = this.sessions.get(clientId);
      if (session) {
         try {
            session.term.kill();
         } catch {
            /* already gone */
         }
         this.sessions.delete(clientId);
      }
   }

   private emitSafe(client: Socket, event: string, payload: unknown) {
      try {
         client.emit(event, payload);
      } catch (err) {
         this.safeLog("error", `emit '${event}' failed: ${(err as Error)?.message}`);
      }
   }

   private safeLog(level: "log" | "warn" | "error", message: string) {
      try {
         this.logger[level](`RemoteTerminalGateway: ${message}`);
      } catch {
         /* never let logging crash us */
      }
   }
}
