import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { exec } from "child_process";
import { promisify } from "util";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { type Readable } from "stream";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "src/config/config.validator";
import { TrafficService } from "src/traffic.service";

const execAsync = promisify(exec);

export interface MicroserviceEntry {
   name: string;
   port: number;
   tcpPort?: number;
   lastHeartbeat: Date;
   traffic?: {
      since: string;
      totalRequests: number;
      totalBytesSent: number;
      totalBytesReceived: number;
      totalBytes: number;
      byPattern: Record<string, { requests: number; bytesSent: number; bytesReceived: number }>;
   };
}

const HEARTBEAT_TIMEOUT_MS = 60_000; // consider dead after 60s without heartbeat
const REDIS_MS_KEY = "microservices:registry";
const REDIS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

@Injectable()
export class AppMetricsService {
   constructor(
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      @Inject() private readonly fs: AbstractFileSystem,
      private readonly config: ConfigService<EnvVariables>,
      private readonly trafficService: TrafficService,
   ) {}

   public async heartbeat(name: string, port: number, tcpPort?: number, traffic?: MicroserviceEntry["traffic"]) {
      const entry: MicroserviceEntry = { name, port, tcpPort, lastHeartbeat: new Date(), traffic };
      await this.redis.hset(REDIS_MS_KEY, name, JSON.stringify(entry));
      await this.redis.expire(REDIS_MS_KEY, REDIS_TTL_SECONDS);
   }

   public async unregisterMicroservice(name: string) {
      await this.redis.hdel(REDIS_MS_KEY, name);
   }

   public async getMicroserviceStatuses() {
      const all = await this.redis.hgetall(REDIS_MS_KEY);
      const now = Date.now();

      const services = Object.values(all).map((raw) => {
         const svc: MicroserviceEntry = JSON.parse(raw);
         const age = now - new Date(svc.lastHeartbeat).getTime();
         return {
            name: svc.name,
            port: svc.port,
            tcpPort: svc.tcpPort,
            status: age < HEARTBEAT_TIMEOUT_MS ? "up" as const : "down" as const,
            lastHeartbeat: svc.lastHeartbeat,
            traffic: this.trimTraffic(svc.traffic),
            isSelf: false,
         };
      });

      // Always include shado-cloud itself
      if (!services.some(s => s.name === "shado-cloud-backend")) {
         services.unshift({
            name: "shado-cloud-backend",
            port: this.config.get("APP_PORT") || 9000,
            tcpPort: undefined,
            status: "up",
            lastHeartbeat: new Date() as any,
            traffic: this.trimTraffic(this.trafficService.getStats()),
            isSelf: true,
         });
      }

      return services;
   }

   private trimTraffic(traffic?: MicroserviceEntry["traffic"]): MicroserviceEntry["traffic"] {
      if (!traffic?.byPattern) return traffic;
      const top = Object.entries(traffic.byPattern)
         .sort(([, a], [, b]) => (b.bytesSent + b.bytesReceived) - (a.bytesSent + a.bytesReceived))
         .slice(0, 3);
      return { ...traffic, byPattern: Object.fromEntries(top) };
   }

   public async getPm2Logs(processName: string, lines: number = 100): Promise<{ stdout: string; stderr: string }> {
      try {
         const { stdout: jlist } = await execAsync(`pm2 jlist`, { maxBuffer: 5 * 1024 * 1024 });
         const processes = JSON.parse(jlist);
         const proc = processes.find((p: any) => p.name === processName);
         if (!proc) return { stdout: `Process "${processName}" not found in pm2`, stderr: "" };

         const outLog = proc.pm2_env?.pm_out_log_path;
         const errLog = proc.pm2_env?.pm_err_log_path;

         const readTail = async (file: string) => {
            try {
               const { stdout } = await execAsync(`tail -n ${lines} "${file}"`, { maxBuffer: 5 * 1024 * 1024 });
               return stdout;
            } catch { return ""; }
         };

         const [stdout, stderr] = await Promise.all([
            outLog ? readTail(outLog) : Promise.resolve(""),
            errLog ? readTail(errLog) : Promise.resolve(""),
         ]);

         return { stdout, stderr };
      } catch (e) {
         return { stdout: "", stderr: (e as any).stdout || (e as Error).message };
      }
   }

   /**
    * Execute a raw Redis command via the ioredis client.
    * Parses the command string into tokens and calls redis.call().
    */
   public async execRedisCommand(command: string): Promise<any> {
      const tokens = this.parseRedisCommand(command.trim());
      if (tokens.length === 0) throw new Error("Empty command");
      const [cmd, ...args] = tokens;
      return await (this.redis as any).call(cmd, ...args);
   }

   private parseRedisCommand(input: string): string[] {
      const tokens: string[] = [];
      let i = 0;
      while (i < input.length) {
         if (input[i] === " ") { i++; continue; }
         if (input[i] === '"' || input[i] === "'") {
            const quote = input[i++];
            let token = "";
            while (i < input.length && input[i] !== quote) token += input[i++];
            i++; // skip closing quote
            tokens.push(token);
         } else {
            let token = "";
            while (i < input.length && input[i] !== " ") token += input[i++];
            tokens.push(token);
         }
      }
      return tokens;
   }

   /**
    * Read redis-server logs. Asks Redis for its logfile path via CONFIG GET.
    * lines=0 means return the entire file.
    */
   public async getRedisLogs(lines = 100): Promise<string> {
      const [, logPath] = await this.redis.config("GET", "logfile") as [string, string];

      if (logPath && this.fs.existsSync(logPath)) {
         try {
            return await this.tailFile(this.fs.createReadStream(logPath, "utf-8"), lines);
         } catch (e) {
            return `Found logfile "${logPath}" but failed to read: ${(e as Error).message}`;
         }
      }

      // Fallback: journalctl on Linux (Redis may log to stdout/systemd)
      if (process.platform !== "darwin") {
         try {
            const cmd = lines > 0
               ? `journalctl -u redis-server -n ${lines} --no-pager 2>/dev/null || journalctl -u redis -n ${lines} --no-pager`
               : `journalctl -u redis-server --no-pager 2>/dev/null || journalctl -u redis --no-pager`;
            const { stdout } = await execAsync(cmd);
            if (stdout.trim()) return stdout;
         } catch {}
      }

      return logPath
         ? `Redis logfile is "${logPath}" but it could not be read`
         : "Redis logfile is not configured (empty string). Redis may be logging to stdout.";
   }

   /**
    * Streams a file and returns the last N lines (or all if lines=0).
    * Only keeps a rolling buffer of N lines in memory.
    */
   private tailFile(stream: Readable, lines: number): Promise<string> {
      return new Promise((resolve, reject) => {
         if (lines === 0) {
            const chunks: string[] = [];
            stream.on("data", (chunk: string) => chunks.push(chunk));
            stream.on("end", () => resolve(chunks.join("")));
            stream.on("error", reject);
            return;
         }

         const buf: string[] = [];
         let partial = "";

         stream.on("data", (chunk: string) => {
            const parts = (partial + chunk).split("\n");
            partial = parts.pop()!; // last element is incomplete line
            for (const line of parts) {
               buf.push(line);
               if (buf.length > lines) buf.shift();
            }
         });

         stream.on("end", () => {
            if (partial) {
               buf.push(partial);
               if (buf.length > lines) buf.shift();
            }
            resolve(buf.join("\n"));
         });

         stream.on("error", reject);
      });
   }

}
