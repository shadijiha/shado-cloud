import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

@Injectable()
export class AppMetricsService {
   // Max length of string values to dump
   private readonly maxLength = 150;

   constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

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
      return {
         cpu: {
            usage: cpuUsage,
            cores: cpus.length,
            model: cpus[0]?.model || "Unknown"
         },
         memory: memUsage,
         disk: diskUsage,
         uptime: os.uptime(),
         loadAvg: os.loadavg(),
         topProcesses
      };
   }

   public async redisInfo(section: string): Promise<string> {
      return await this.redis.info(section);
   }

   // Method to dump all Redis keys and their values
   public async dumpRedisCache() {
      const allKeys: string[] = await this.getAllKeys();
      const keyValuePairs: Record<string, string | object> = {};

      for (const key of allKeys) {
         const value = await this.redis.get(key); // This works for string values
         if (value) {
            keyValuePairs[key] = this.trimString(value); // Trim long string values
         } else {
            // If the value is not a string, try other types like hashes, lists, etc.
            const hashValue = await this.redis.hgetall(key);
            if (Object.keys(hashValue).length > 0) {
               keyValuePairs[key] = hashValue;
            }

            const listValue = await this.redis.lrange(key, 0, -1); // List
            if (listValue.length > 0) {
               keyValuePairs[key] = listValue;
            }

            const setValue = await this.redis.smembers(key); // Set
            if (setValue.length > 0) {
               keyValuePairs[key] = setValue;
            }

            const zsetValue = await this.redis.zrange(key, 0, -1); // Sorted Set
            if (zsetValue.length > 0) {
               keyValuePairs[key] = zsetValue;
            }
         }
      }
      return keyValuePairs; // You can log it, return it, or store it as needed.
   }

   // Helper method to fetch all keys using SCAN to avoid blocking the Redis server
   private async getAllKeys(): Promise<string[]> {
      let cursor = "0";
      let allKeys: string[] = [];

      do {
         const result = await this.redis.scan(cursor);
         cursor = result[0];
         allKeys = allKeys.concat(result[1]);
      } while (cursor !== "0"); // Continue until all keys are retrieved

      return allKeys;
   }

   // Helper method to trim long string values
   private trimString(value: string): string {
      if (value.length > this.maxLength) {
         return value.slice(0, this.maxLength) + "..."; // Truncate and add ellipsis
      }
      return value; // Return the string as-is if it's shorter than maxLength
   }
}
