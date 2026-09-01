import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PipelinePromotionBlocker } from "src/models/admin/pipeline/pipelinePromotionBlocker";
import {
   AlarmConfig,
   BlockerKind,
   BlockerState,
   ManualApprovalConfig,
   TimeWindowConfig,
} from "src/models/admin/pipeline/pipeline.types";

export interface BlockerEvaluation {
   blockerId: number;
   kind: BlockerKind;
   name: string;
   state: BlockerState;
   /** Human readable explanation shown in the UI tooltip and the run banner. */
   reason: string;
   /** True when this blocker requires a human to release it. */
   needsHuman: boolean;
}

export interface PromotionEvaluation {
   /** Every enabled blocker on the promotion with its resolved state. */
   evaluations: BlockerEvaluation[];
   /** Only those currently blocking. */
   blocking: BlockerEvaluation[];
   /** True when at least one blocker is holding the promotion. */
   isBlocked: boolean;
   /** Combined reason string, empty when not blocked. */
   reason: string;
   /** True when every blocking blocker is a manual gate (i.e. waiting on a person). */
   awaitingApproval: boolean;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Resolves the live state of promotion blockers.
 *
 * Time windows are computed from the clock on every evaluation. Alarms may be
 * polled over HTTP (non-200 = in alarm) or driven manually. Locks and manual
 * approval gates are pure database state toggled through the API.
 */
@Injectable()
export class PromotionBlockerService {
   private readonly logger = new Logger(PromotionBlockerService.name);

   constructor(
      @InjectRepository(PipelinePromotionBlocker)
      private readonly blockerRepo: Repository<PipelinePromotionBlocker>,
   ) {}

   /** Minutes since local midnight for a "HH:MM" string, or null when malformed. */
   private parseTimeOfDay(value: string | undefined): number | null {
      if (!value) return null;
      const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
      if (!match) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours > 23 || minutes > 59) return null;
      return hours * 60 + minutes;
   }

   /**
    * Reads "now" in the blocker's timezone. Falls back to server local time when
    * the timezone is missing or unsupported by the runtime's ICU data.
    */
   private nowInTimezone(timezone: string | undefined, at: Date): { day: number; minutes: number } {
      if (!timezone) {
         return { day: at.getDay(), minutes: at.getHours() * 60 + at.getMinutes() };
      }
      try {
         const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
         });
         const parts = formatter.formatToParts(at);
         const weekday = parts.find((p) => p.type === "weekday")?.value ?? DAY_NAMES[at.getDay()];
         const hour = Number(parts.find((p) => p.type === "hour")?.value ?? at.getHours());
         const minute = Number(parts.find((p) => p.type === "minute")?.value ?? at.getMinutes());
         const day = DAY_NAMES.indexOf(weekday);
         return {
            day: day === -1 ? at.getDay() : day,
            // Intl renders midnight as "24" in some locales/runtimes.
            minutes: (hour % 24) * 60 + minute,
         };
      } catch {
         this.logger.warn(`Unknown timezone "${timezone}", falling back to server local time`);
         return { day: at.getDay(), minutes: at.getHours() * 60 + at.getMinutes() };
      }
   }

   /**
    * True when `at` falls inside the configured window.
    * Windows whose end time is <= start time are treated as crossing midnight.
    */
   public isInsideTimeWindow(config: Partial<TimeWindowConfig>, at: Date = new Date()): boolean {
      const start = this.parseTimeOfDay(config.startTime) ?? 0;
      const end = this.parseTimeOfDay(config.endTime) ?? 24 * 60;
      const { day, minutes } = this.nowInTimezone(config.timezone, at);

      const days = config.daysOfWeek ?? [];
      const crossesMidnight = end <= start;

      // For a window that crosses midnight the day-of-week check applies to the
      // day the window *opened*, so the post-midnight tail belongs to the
      // previous day.
      const effectiveDay = crossesMidnight && minutes < start ? (day + 6) % 7 : day;
      if (days.length > 0 && !days.includes(effectiveDay)) return false;

      return crossesMidnight ? minutes >= start || minutes < end : minutes >= start && minutes < end;
   }

   private describeTimeWindow(config: Partial<TimeWindowConfig>): string {
      const days = config.daysOfWeek?.length ? config.daysOfWeek.map((d) => DAY_NAMES[d] ?? d).join(", ") : "every day";
      const tz = config.timezone ? ` ${config.timezone}` : "";
      return `${days} ${config.startTime ?? "00:00"}–${config.endTime ?? "24:00"}${tz}`;
   }

   /** Polls an alarm's health endpoint and persists the resulting state. */
   public async refreshAlarm(blocker: PipelinePromotionBlocker): Promise<BlockerState> {
      const config = blocker.getConfig<AlarmConfig>();
      if (!config.healthUrl) {
         return config.manualState ?? blocker.state ?? BlockerState.Ok;
      }
      let next: BlockerState;
      try {
         const controller = new AbortController();
         const timer = setTimeout(() => controller.abort(), 5_000);
         const res = await fetch(config.healthUrl, { signal: controller.signal });
         clearTimeout(timer);
         next = res.ok ? BlockerState.Ok : BlockerState.Blocking;
      } catch (e) {
         this.logger.warn(`Alarm probe failed for "${blocker.name}": ${(e as Error).message}`);
         next = BlockerState.Unknown;
      }
      if (next !== blocker.state) {
         blocker.state = next;
         blocker.lastStateChange = new Date();
         await this.blockerRepo.save(blocker);
      }
      return next;
   }

   private async evaluateOne(blocker: PipelinePromotionBlocker, at: Date): Promise<BlockerEvaluation> {
      const base = { blockerId: blocker.id, kind: blocker.kind, name: blocker.name };

      switch (blocker.kind) {
         case BlockerKind.TimeWindow: {
            const config = blocker.getConfig<TimeWindowConfig>();
            const inside = this.isInsideTimeWindow(config, at);
            // `invert` flips the meaning: the window describes a freeze period.
            const open = config.invert ? !inside : inside;
            return {
               ...base,
               state: open ? BlockerState.Ok : BlockerState.Blocking,
               reason: open
                  ? `Time window open (${this.describeTimeWindow(config)})`
                  : `Outside time window ${this.describeTimeWindow(config)}`,
               needsHuman: false,
            };
         }
         case BlockerKind.Alarm: {
            const state = await this.refreshAlarm(blocker);
            const config = blocker.getConfig<AlarmConfig>();
            const monitor = config.monitor || blocker.name;
            // INSUFFICIENT_DATA is treated as blocking, same as a firing alarm.
            const blocking = state !== BlockerState.Ok;
            return {
               ...base,
               state,
               reason: blocking
                  ? `Monitor "${monitor}" is ${state === BlockerState.Unknown ? "in an unknown state" : "in alarm"}`
                  : `Monitor "${monitor}" is healthy`,
               needsHuman: false,
            };
         }
         case BlockerKind.Lock: {
            const blocking = blocker.state !== BlockerState.Ok;
            return {
               ...base,
               state: blocker.state,
               reason: blocking ? `Environment locked (${blocker.name})` : `Lock released (${blocker.name})`,
               needsHuman: true,
            };
         }
         case BlockerKind.ManualApproval: {
            const config = blocker.getConfig<ManualApprovalConfig>();
            const blocking = blocker.state !== BlockerState.Ok;
            return {
               ...base,
               state: blocker.state,
               reason: blocking
                  ? config.prompt || `Waiting for manual approval: ${blocker.name}`
                  : `Approved: ${blocker.name}`,
               needsHuman: true,
            };
         }
         default:
            return { ...base, state: BlockerState.Ok, reason: "", needsHuman: false };
      }
   }

   /** Evaluates every enabled blocker attached to a promotion. */
   public async evaluate(
      blockers: PipelinePromotionBlocker[] | undefined,
      at: Date = new Date(),
   ): Promise<PromotionEvaluation> {
      const active = (blockers ?? []).filter((b) => b.enabled);
      const evaluations = await Promise.all(active.map((b) => this.evaluateOne(b, at)));
      const blocking = evaluations.filter((e) => e.state !== BlockerState.Ok);

      return {
         evaluations,
         blocking,
         isBlocked: blocking.length > 0,
         reason: blocking.map((b) => b.reason).join("; "),
         awaitingApproval: blocking.length > 0 && blocking.every((b) => b.needsHuman),
      };
   }

   /** Flips a manual-approval or lock blocker to OK, releasing the promotion. */
   public async release(blockerId: number, releasedBy: string): Promise<PipelinePromotionBlocker> {
      const blocker = await this.blockerRepo.findOneBy({ id: blockerId });
      if (!blocker) throw new Error(`Blocker ${blockerId} not found`);
      blocker.state = BlockerState.Ok;
      blocker.lastStateChange = new Date();
      this.logger.log(`Blocker "${blocker.name}" released by ${releasedBy}`);
      return this.blockerRepo.save(blocker);
   }

   /**
    * Re-arms a manual gate so the next run stops at it again. Called after a run
    * passes a manual approval so approvals are not permanently granted.
    */
   public async rearm(blockerId: number): Promise<void> {
      const blocker = await this.blockerRepo.findOneBy({ id: blockerId });
      if (!blocker) return;
      if (blocker.kind !== BlockerKind.ManualApproval && blocker.kind !== BlockerKind.Lock) return;
      blocker.state = BlockerState.Blocking;
      blocker.lastStateChange = new Date();
      await this.blockerRepo.save(blocker);
   }
}
