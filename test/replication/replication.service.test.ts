import { ReplicationService } from "src/replication/replication.service";
import { ReplicationRole } from "src/config/config.validator";

/**
 * Regression test for the stale-replica alert de-duplication.
 *
 * The hourly `checkStaleReplicas` cron can end up running more than once per tick
 * (e.g. when ScheduleModule.forRoot() is registered by multiple modules in the same
 * process). Before the fix it emailed *then* removed the registry entry, so several
 * concurrent runs all saw the same stale entry and each sent an email — one stale
 * replica produced multiple emails.
 *
 * The fix claims the entry atomically with HDEL (which returns the number of fields
 * actually removed) *before* sending, so exactly one run wins and emails.
 */
describe("ReplicationService.checkStaleReplicas — alert de-duplication", () => {
   const REGISTRY_KEY = ReplicationService.REPLICAS_KEY;
   const NOW = Date.now();
   const STALE = NOW - 25 * 60 * 60 * 1000; // 25h idle (> 24h cutoff)
   const FRESH = NOW - 60 * 1000; // 1 min idle

   /** Redis mock backed by a real Map, so HDEL is a genuine atomic claim (1 once, then 0). */
   function makeRedis(entries: Record<string, unknown>) {
      const store = new Map<string, string>(
         Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]),
      );
      return {
         store,
         hgetall: jest.fn(async () => Object.fromEntries(store)),
         hdel: jest.fn(async (_key: string, field: string) => (store.delete(field) ? 1 : 0)),
      };
   }

   function build(entries: Record<string, unknown>) {
      const redis = makeRedis(entries);
      const email = { sendEmail: jest.fn().mockResolvedValue(undefined) };
      const config = { get: jest.fn().mockReturnValue(ReplicationRole.Master) };
      const service = new ReplicationService(
         config as any,
         {} as any, // fs — unused by checkStaleReplicas
         redis as any,
         email as any,
      );
      return { service, redis, email };
   }

   const staleRecord = (overrides: Record<string, unknown> = {}) => ({
      ip: "1.2.3.4",
      deviceName: "replica-box",
      userAgent: "Service/Shado-Cloud",
      requestCount: 42,
      firstSeenAt: NOW - 30 * 24 * 60 * 60 * 1000,
      lastSeenAt: STALE,
      ...overrides,
   });

   it("emails exactly once even when the cron runs 3× concurrently for one stale replica", async () => {
      const { service, email, redis } = build({ "1.2.3.4|replica-box": staleRecord() });

      // Simulate ScheduleModule firing the same cron three times on the same tick.
      await Promise.all([
         service.checkStaleReplicas(),
         service.checkStaleReplicas(),
         service.checkStaleReplicas(),
      ]);

      expect(email.sendEmail).toHaveBeenCalledTimes(1);
      // The entry was claimed/removed from the registry.
      expect(redis.store.has("1.2.3.4|replica-box")).toBe(false);
   });

   it("does not email or remove a replica that is still within the 24h window", async () => {
      const { service, email, redis } = build({ "5.6.7.8|fresh": staleRecord({ lastSeenAt: FRESH }) });

      await service.checkStaleReplicas();

      expect(email.sendEmail).not.toHaveBeenCalled();
      expect(redis.store.has("5.6.7.8|fresh")).toBe(true);
   });

   it("emails once per distinct stale replica", async () => {
      const { service, email } = build({
         "1.1.1.1|a": staleRecord({ ip: "1.1.1.1", deviceName: "a" }),
         "2.2.2.2|b": staleRecord({ ip: "2.2.2.2", deviceName: "b" }),
      });

      await service.checkStaleReplicas();

      expect(email.sendEmail).toHaveBeenCalledTimes(2);
   });

   it("is a no-op on a replica node (only the master alerts)", async () => {
      const redis = makeRedis({ "1.2.3.4|replica-box": staleRecord() });
      const email = { sendEmail: jest.fn() };
      const config = { get: jest.fn().mockReturnValue(ReplicationRole.Replica) };
      const service = new ReplicationService(config as any, {} as any, redis as any, email as any);

      await service.checkStaleReplicas();

      expect(email.sendEmail).not.toHaveBeenCalled();
      expect(redis.hgetall).not.toHaveBeenCalled();
   });
});
