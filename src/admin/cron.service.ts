import { Injectable, NotFoundException } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";

export interface CronJobInfo {
   /** Stable identifier used to trigger the job (the @Cron name). */
   name: string;
   /** Raw cron expression (5- or 6-field). */
   expression: string;
   /** Human-readable description of the schedule. */
   human: string;
   /** ISO timestamp of the last run (scheduled or manual), or null if it hasn't run yet. */
   lastRun: string | null;
   /** ISO timestamp of the next scheduled run, or null if it can't be computed. */
   nextRun: string | null;
   /** Whether the job is currently scheduled/active. */
   running: boolean;
   /** Wall-clock duration of the most recent run in ms, or null if it hasn't run yet. */
   lastDurationMs: number | null;
}

@Injectable()
export class CronAdminService {
   /** Tracks the last manual trigger per job — `fireOnTick()` does not update the cron's own lastDate. */
   private readonly manualRuns = new Map<string, number>();

   constructor(private readonly registry: SchedulerRegistry) {}

   /** Snapshot of every registered cron job for the admin UI. */
   public list(): CronJobInfo[] {
      const out: CronJobInfo[] = [];
      for (const [name, job] of this.registry.getCronJobs()) {
         ensureCronTimed(name, job);
         const source = (job.cronTime as { source?: unknown })?.source;
         const expression = typeof source === "string" ? source : String(source ?? "");
         out.push({
            name,
            expression,
            human: humanizeCron(expression),
            lastRun: this.resolveLastRun(name, job),
            nextRun: this.resolveNextRun(job),
            running: this.isRunning(job),
            lastDurationMs: cronLastDurationMs.get(name) ?? null,
         });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
   }

   /** Fire a job's handler immediately. Throws NotFound if the name is unknown. */
   public async trigger(name: string): Promise<{ name: string; triggeredAt: string }> {
      let job: ReturnType<SchedulerRegistry["getCronJob"]>;
      try {
         job = this.registry.getCronJob(name);
      } catch {
         throw new NotFoundException(`No cron job named "${name}"`);
      }
      const now = Date.now();
      this.manualRuns.set(name, now);
      await job.fireOnTick();
      return { name, triggeredAt: new Date(now).toISOString() };
   }

   private resolveLastRun(name: string, job: { lastDate?: () => Date | null }): string | null {
      let cronMs = 0;
      try {
         const last = job.lastDate?.();
         if (last) cronMs = new Date(last).getTime();
      } catch {
         /* lastDate may throw if never scheduled */
      }
      const manualMs = this.manualRuns.get(name) ?? 0;
      const ms = Math.max(cronMs, manualMs);
      return ms > 0 ? new Date(ms).toISOString() : null;
   }

   private resolveNextRun(job: { nextDate?: () => unknown }): string | null {
      try {
         return toIso(job.nextDate?.());
      } catch {
         return null;
      }
   }

   private isRunning(job: unknown): boolean {
      const j = job as { isActive?: boolean; running?: boolean };
      return Boolean(j.isActive ?? j.running);
   }
}

/** Normalises a Luxon DateTime, JS Date, or epoch-ms into an ISO string. */
function toIso(value: unknown): string | null {
   if (value == null) return null;
   if (value instanceof Date) return value.toISOString();
   const candidate = value as { toISO?: () => string | null; toMillis?: () => number };
   if (typeof candidate.toISO === "function") return candidate.toISO();
   if (typeof candidate.toMillis === "function") return new Date(candidate.toMillis()).toISOString();
   return null;
}

/** Renders an hour/minute pair as a 12-hour clock label (e.g. "3:00 AM", "12:00 AM (midnight)"). */
function formatTime(hour: number, minute: number): string {
   const mm = minute.toString().padStart(2, "0");
   const period = hour < 12 ? "AM" : "PM";
   let h12 = hour % 12;
   if (h12 === 0) h12 = 12;
   let label = `${h12}:${mm} ${period}`;
   if (hour === 0 && minute === 0) label += " (midnight)";
   else if (hour === 12 && minute === 0) label += " (noon)";
   return label;
}

/**
 * Converts a standard cron expression (5-field, or 6-field with leading seconds)
 * into a human-readable description. Falls back to the raw expression for shapes
 * it doesn't recognise.
 */
export function humanizeCron(expr: string): string {
   if (!expr || typeof expr !== "string") return "Unknown schedule";
   const parts = expr.trim().split(/\s+/);

   let sec = "0";
   let min: string, hour: string, dom: string, mon: string, dow: string;
   if (parts.length === 6) [sec, min, hour, dom, mon, dow] = parts;
   else if (parts.length === 5) [min, hour, dom, mon, dow] = parts;
   else return expr;

   const allWild = dom === "*" && mon === "*" && dow === "*";

   // Every N seconds (6-field only)
   if (parts.length === 6) {
      const secEvery = /^\*\/(\d+)$/.exec(sec);
      if (secEvery && min === "*" && hour === "*" && allWild) {
         return secEvery[1] === "1" ? "Every second" : `Every ${secEvery[1]} seconds`;
      }
      if (sec === "*" && min === "*" && hour === "*" && allWild) return "Every second";
   }

   const secAtTop = parts.length === 5 || sec === "0" || sec === "*";

   // Every minute
   if ((min === "*" || min === "*/1") && hour === "*" && allWild && secAtTop) return "Every minute";

   // Every N minutes
   const minEvery = /^\*\/(\d+)$/.exec(min);
   if (minEvery && hour === "*" && allWild && secAtTop) {
      return minEvery[1] === "1" ? "Every minute" : `Every ${minEvery[1]} minutes`;
   }

   // Every hour (fixed minute, any hour)
   if (/^\d+$/.test(min) && (hour === "*" || hour === "*/1" || hour === "0-23/1") && allWild && secAtTop) {
      return min === "0" ? "Every hour" : `Every hour at minute ${Number(min)}`;
   }

   // Every N hours
   const hourEvery = /^\*\/(\d+)$/.exec(hour);
   if (/^\d+$/.test(min) && hourEvery && allWild && secAtTop) {
      return `Every ${hourEvery[1]} hours`;
   }

   // Daily at a fixed time
   if (/^\d+$/.test(min) && /^\d+$/.test(hour) && allWild && secAtTop) {
      return `Every day at ${formatTime(Number(hour), Number(min))}`;
   }

   return expr;
}

/**
 * Read-only snapshot of every registered cron job, for cross-service reporting via heartbeat.
 * Same shape as CronAdminService.list() but without manual-run tracking (pure function).
 */
export function collectCronJobs(registry: SchedulerRegistry): CronJobInfo[] {
   const out: CronJobInfo[] = [];
   let jobs: Map<string, { cronTime?: { source?: unknown }; lastDate?: () => unknown; nextDate?: () => unknown; isActive?: boolean; running?: boolean }>;
   try {
      jobs = registry.getCronJobs() as never;
   } catch {
      return out;
   }
   for (const [name, job] of jobs) {
      ensureCronTimed(name, job);
      const source = job.cronTime?.source;
      const expression = typeof source === "string" ? source : String(source ?? "");
      let lastRun: string | null = null;
      try {
         const l = job.lastDate?.();
         lastRun = l ? new Date(l as Date).toISOString() : null;
      } catch {
         /* lastDate may throw before first schedule */
      }
      let nextRun: string | null = null;
      try {
         nextRun = toIso(job.nextDate?.());
      } catch {
         /* ignore */
      }
      out.push({ name, expression, human: humanizeCron(expression), lastRun, nextRun, running: Boolean(job.isActive ?? job.running), lastDurationMs: cronLastDurationMs.get(name) ?? null });
   }
   return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Times cron-job runs. The `cron` library doesn't record run duration, and its `fireOnTick`
 * does NOT await async callbacks (waitForCompletion defaults to false) — so timing fireOnTick
 * would only capture the synchronous slice (≈0ms for I/O-bound jobs). Instead we wrap the job's
 * actual callback and measure its returned promise, capturing the full async duration without
 * changing cron's scheduling behaviour.
 */
const cronLastDurationMs = new Map<string, number>();
const timedCronJobs = new WeakSet<object>();

function ensureCronTimed(name: string, job: unknown): void {
   const j = job as { _callbacks?: Array<(...args: unknown[]) => unknown> };
   const callbacks = j._callbacks;
   if (!Array.isArray(callbacks) || timedCronJobs.has(j)) return;
   for (let i = 0; i < callbacks.length; i++) {
      const original = callbacks[i];
      callbacks[i] = function (this: unknown, ...args: unknown[]) {
         const start = Date.now();
         const record = () => cronLastDurationMs.set(name, Date.now() - start);
         const result = original.apply(this, args);
         if (result && typeof (result as { then?: unknown }).then === "function") {
            // settle on both success and failure; provide both handlers so we never create
            // a second unhandled rejection (cron already attaches its own .catch).
            void Promise.resolve(result).then(record, record);
         } else {
            record();
         }
         return result;
      };
   }
   timedCronJobs.add(j);
}
