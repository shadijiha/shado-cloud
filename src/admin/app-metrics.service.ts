import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import * as os from "os";
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
   private prevCpuTimes: { idle: number; total: number }[] = [];

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

   public async getSystemInfo() {
      const isMac = process.platform === "darwin";
      
      // Local IP
      let localIp = "Unknown";
      const nets = os.networkInterfaces();
      for (const ifaces of Object.values(nets)) {
         for (const iface of ifaces || []) {
            if (iface.family === "IPv4" && !iface.internal) {
               localIp = iface.address;
               break;
            }
         }
         if (localIp !== "Unknown") break;
      }

      // Public IP
      let publicIp = "Unknown";
      try {
         const { stdout } = await execAsync("curl -s --max-time 3 https://api.ipify.org");
         if (stdout.trim()) publicIp = stdout.trim();
      } catch {}

      // MAC address
      let macAddress = "Unknown";
      for (const ifaces of Object.values(nets)) {
         for (const iface of ifaces || []) {
            if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
               macAddress = iface.mac;
               break;
            }
         }
         if (macAddress !== "Unknown") break;
      }

      // Full CPU name
      let cpuName = os.cpus()[0]?.model || "Unknown";
      try {
         if (isMac) {
            const { stdout } = await execAsync("sysctl -n machdep.cpu.brand_string");
            if (stdout.trim()) cpuName = stdout.trim();
         } else {
            const { stdout } = await execAsync("cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2");
            if (stdout.trim()) cpuName = stdout.trim();
         }
      } catch {}

      // Motherboard
      let motherboard = "Unknown";
      try {
         if (isMac) {
            const { stdout } = await execAsync("sysctl -n hw.model");
            if (stdout.trim()) motherboard = stdout.trim();
         } else {
            const { stdout: mfg } = await execAsync("cat /sys/devices/virtual/dmi/id/board_vendor 2>/dev/null || echo Unknown");
            const { stdout: prod } = await execAsync("cat /sys/devices/virtual/dmi/id/board_name 2>/dev/null || echo Unknown");
            motherboard = `${mfg.trim()} ${prod.trim()}`.trim();
         }
      } catch {}

      // Memory speed
      let memorySpeed = "Unknown";
      try {
         if (isMac) {
            const { stdout } = await execAsync("system_profiler SPMemoryDataType 2>/dev/null | grep Speed | head -1");
            const match = stdout.match(/Speed:\s*(.+)/);
            if (match) memorySpeed = match[1].trim();
         } else {
            const { stdout } = await execAsync("dmidecode -t memory 2>/dev/null | grep -i 'configured memory speed' | head -1 || echo ''");
            const match = stdout.match(/:\s*(.+)/);
            if (match && match[1].trim() !== "Unknown") memorySpeed = match[1].trim();
         }
      } catch {}

      // Memory type
      let memoryType = "Unknown";
      try {
         if (isMac) {
            const { stdout } = await execAsync("system_profiler SPMemoryDataType 2>/dev/null | grep Type | head -1");
            const match = stdout.match(/Type:\s*(.+)/);
            if (match) memoryType = match[1].trim();
         } else {
            const { stdout } = await execAsync("dmidecode -t memory 2>/dev/null | grep -i '^\tType:' | head -1 || echo ''");
            const match = stdout.match(/Type:\s*(.+)/);
            if (match && match[1].trim() !== "Unknown") memoryType = match[1].trim();
         }
      } catch {}

      // Mounted storage devices
      let storageDevices: { name: string; mountPoint: string; total: number; used: number; free: number; percent: number }[] = [];
      try {
         if (isMac) {
            const { stdout } = await execAsync("df -kl | grep '^/dev/'");
            storageDevices = stdout.trim().split("\n").filter(Boolean).map(line => {
               const p = line.split(/\s+/);
               const total = parseInt(p[1]) * 1024;
               const used = parseInt(p[2]) * 1024;
               const free = parseInt(p[3]) * 1024;
               return { name: p[0], mountPoint: p.slice(8).join(" ") || p[5], total, used, free, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
            });
         } else {
            const { stdout } = await execAsync("df -kT --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay 2>/dev/null || df -k");
            const lines = stdout.trim().split("\n").slice(1).filter(l => l.startsWith("/"));
            storageDevices = lines.map(line => {
               const p = line.split(/\s+/);
               const hasType = stdout.includes("Type"); // df -kT includes type column
               const offset = hasType ? 1 : 0;
               const total = parseInt(p[1 + offset]) * 1024;
               const used = parseInt(p[2 + offset]) * 1024;
               const free = parseInt(p[3 + offset]) * 1024;
               return { name: p[0], mountPoint: p[5 + offset], total, used, free, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
            });
         }
      } catch {}

      return {
         hostname: os.hostname(),
         platform: process.platform,
         os: `${os.type()} ${os.release()}`,
         arch: os.arch(),
         localIp,
         publicIp,
         macAddress,
         cpu: cpuName,
         cpuCores: os.cpus().length,
         motherboard,
         totalMemory: os.totalmem(),
         memorySpeed,
         memoryType,
         storageDevices,
         nodeVersion: process.version,
         uptime: os.uptime(),
      };
   }

   public async getSystemMetrics() {
      const isMac = process.platform === "darwin";

      // Get CPU usage from system command
      let cpuUsage = 0;
      try {
         if (isMac) {
            const { stdout } = await execAsync("top -l 1 -n 0 | grep 'CPU usage'");
            const match = stdout.match(/(\d+\.?\d*)% idle/);
            if (match) cpuUsage = Math.round((100 - parseFloat(match[1])) * 10) / 10;
         } else {
            const { stdout } = await execAsync("top -bn1 | grep 'Cpu(s)'");
            const match = stdout.match(/(\d+\.?\d*)\s*id/);
            if (match) cpuUsage = Math.round((100 - parseFloat(match[1])) * 10) / 10;
         }
      } catch {}

      // Get memory usage from system command
      let memUsage = { total: 0, used: 0, free: 0, percent: 0 };
      try {
         if (isMac) {
            // Use vm_stat for accurate macOS memory
            const { stdout: vmStat } = await execAsync("vm_stat");
            const pageSize = 16384; // macOS default page size
            const pages = (name: string) => {
               const match = vmStat.match(new RegExp(`${name}:\\s+(\\d+)`));
               return match ? parseInt(match[1]) * pageSize : 0;
            };
            
            const free = pages("Pages free");
            const active = pages("Pages active");
            const inactive = pages("Pages inactive");
            const speculative = pages("Pages speculative");
            const wired = pages("Pages wired down");
            const compressed = pages("Pages occupied by compressor");
            
            const total = os.totalmem();
            const used = active + wired + compressed;
            memUsage = {
               total,
               used,
               free: total - used,
               percent: Math.round((used / total) * 100 * 10) / 10
            };
         } else {
            const { stdout } = await execAsync("free -b");
            const lines = stdout.trim().split("\n");
            const parts = lines[1].split(/\s+/);
            memUsage = {
               total: parseInt(parts[1]),
               used: parseInt(parts[2]),
               free: parseInt(parts[3]),
               percent: Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100 * 10) / 10
            };
         }
      } catch {
         // Fallback to os module
         const total = os.totalmem();
         const free = os.freemem();
         memUsage = { total, used: total - free, free, percent: Math.round(((total - free) / total) * 100 * 10) / 10 };
      }

      // Disk usage
      let diskUsage = { total: 0, used: 0, free: 0, percent: 0 };
      try {
         if (isMac) {
            const { stdout } = await execAsync("diskutil info / | grep -E 'Container Total Space|Container Free Space'");
            const parseSize = (line: string) => {
               const match = line.match(/\((\d+)\s+Bytes\)/);
               return match ? parseInt(match[1]) : 0;
            };
            const lines = stdout.split("\n");
            let total = 0, free = 0;
            for (const line of lines) {
               if (line.includes("Total Space")) total = parseSize(line);
               if (line.includes("Free Space")) free = parseSize(line);
            }
            const used = total - free;
            diskUsage = {
               total,
               used,
               free,
               percent: total > 0 ? Math.round((used / total) * 100) : 0
            };
         } else {
            // Linux: use df with 1K blocks (more portable than -B1)
            const { stdout } = await execAsync("df -k /");
            const parts = stdout.trim().split("\n")[1].split(/\s+/);
            const total = parseInt(parts[1]) * 1024;
            const used = parseInt(parts[2]) * 1024;
            const free = parseInt(parts[3]) * 1024;
            diskUsage = {
               total,
               used,
               free,
               percent: total > 0 ? Math.round((used / total) * 100) : parseInt(parts[4]) || 0
            };
         }
      } catch {}

      // Disk I/O
      let diskIO = { readBytes: 0, writeBytes: 0 };
      try {
         if (isMac) {
            const { stdout } = await execAsync("ioreg -c IOBlockStorageDriver -r -w 0");
            let totalRead = 0, totalWrite = 0;
            const matches = stdout.matchAll(/"Bytes \(Read\)"=(\d+).*?"Bytes \(Write\)"=(\d+)/g);
            for (const m of matches) {
               totalRead += parseInt(m[1]) || 0;
               totalWrite += parseInt(m[2]) || 0;
            }
            diskIO = { readBytes: totalRead, writeBytes: totalWrite };
         } else {
            const { stdout } = await execAsync("cat /proc/diskstats");
            const lines = stdout.trim().split("\n");
            let totalRead = 0, totalWrite = 0;
            for (const line of lines) {
               const parts = line.trim().split(/\s+/);
               if (parts.length < 14) continue;
               const name = parts[2];
               // Skip loop, ram, and partition devices (ending in digits for sd/vd/xvd, or containing 'p' + digits for nvme/mmcblk)
               if (/^(loop|ram)/.test(name)) continue;
               if (/^(sd|vd|xvd)[a-z]+\d/.test(name)) continue;
               if (/^(nvme|mmcblk)\d+.*p\d+$/.test(name)) continue;
               totalRead += parseInt(parts[5]) || 0;
               totalWrite += parseInt(parts[9]) || 0;
            }
            diskIO = { readBytes: totalRead * 512, writeBytes: totalWrite * 512 };
         }
      } catch {}

      // Top processes
      let topProcesses: { pid: string; name: string; cpu: number; mem: number }[] = [];
      try {
         const cmd = isMac
            ? "ps -Ao pid,comm,%cpu,%mem -r | head -6"
            : "ps -Ao pid,comm,%cpu,%mem --sort=-%cpu | head -6";
         const { stdout } = await execAsync(cmd);
         const lines = stdout.trim().split("\n").slice(1);
         topProcesses = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            return {
               pid: parts[0],
               name: parts[1]?.split("/").pop() || parts[1],
               cpu: parseFloat(parts[2]) || 0,
               mem: parseFloat(parts[3]) || 0
            };
         });
      } catch {}

      const cpus = os.cpus();

      // Per-core usage via delta
      const coreUsages: number[] = cpus.map((cpu, i) => {
         const times = cpu.times;
         const idle = times.idle;
         const total = times.user + times.nice + times.sys + times.irq + times.idle;
         const prev = this.prevCpuTimes[i];
         let usage = 0;
         if (prev) {
            const idleDelta = idle - prev.idle;
            const totalDelta = total - prev.total;
            usage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;
         }
         this.prevCpuTimes[i] = { idle, total };
         return usage;
      });

      return {
         cpu: {
            usage: cpuUsage,
            cores: cpus.length,
            model: cpus[0]?.model || "Unknown",
            coreUsages,
         },
         memory: memUsage,
         disk: diskUsage,
         diskIO,
         uptime: os.uptime(),
         loadAvg: os.loadavg(),
         topProcesses
      };
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
