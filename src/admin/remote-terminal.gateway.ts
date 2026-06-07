import { Inject } from "@nestjs/common";
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
import { LoggerToDb } from "../logging";

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

   /** One PTY shell per connected admin socket. */
   private readonly sessions = new Map<string, IPty>();

   constructor(
      private authService: AuthService,
      @Inject() private readonly logger: LoggerToDb,
   ) {
      if (!pty) {
         this.safeLog("warn", "node-pty not available — terminal sessions will be rejected");
      } else {
         this.safeLog("log", "RemoteTerminalGateway initialized (node-pty)");
      }
   }

   private async isAuthorized(client: Socket): Promise<boolean> {
      try {
         const rawCookies = client.handshake.headers.cookie || "";
         if (!rawCookies) return false;
         const userId = await this.authService.validateCookies(rawCookies);
         if (!userId) return false;
         return await this.authService.isAdmin(userId);
      } catch {
         return false;
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

   async handleConnection(client: Socket) {
      try {
         if (!(await this.isAuthorized(client))) {
            this.safeLog("warn", `Unauthorized terminal connection attempt: ${client.id}`);
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
         let term: IPty;
         try {
            term = pty.spawn(shell, [], {
               name: "xterm-256color",
               cols: 80,
               rows: 24,
               cwd: process.env.HOME || process.cwd(),
               env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as {
                  [key: string]: string;
               },
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

         this.sessions.set(client.id, term);
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
         const term = this.sessions.get(client.id);
         if (term && typeof data === "string") {
            term.write(data);
         }
      } catch (err) {
         this.safeLog("error", `input failed: ${(err as Error)?.message}`);
      }
   }

   @SubscribeMessage("resize")
   handleResize(@ConnectedSocket() client: Socket, @MessageBody() size: ResizeEvent) {
      try {
         const term = this.sessions.get(client.id);
         if (!term || !size) return;
         const cols = Math.max(1, Math.floor(size.cols) || 80);
         const rows = Math.max(1, Math.floor(size.rows) || 24);
         term.resize(cols, rows);
      } catch (err) {
         this.safeLog("error", `resize failed: ${(err as Error)?.message}`);
      }
   }

   private cleanup(clientId: string) {
      const term = this.sessions.get(clientId);
      if (term) {
         try {
            term.kill();
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
