import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type Redis from "ioredis";
import { FeatureFlag, FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { REDIS_CACHE } from "src/util";
import { Repository } from "typeorm";
import { CreateFeatureFlagRequest, UpdateFeatureFlagRequest } from "./adminApiTypes";

type FeatureFlagEventListener = (value: boolean) => Promise<void>;

@Injectable()
export class FeatureFlagService {

   // How long a feature flag is cached in Redis. Bounds how long a flag edited
   // directly in the DB (bypassing enable/disableFeatureFlag) stays stale.
   private static readonly CACHE_TTL_SECONDS = 30;

   private readonly eventListeners: Record<string, { listenerId: string, listener: FeatureFlagEventListener }[]> = {};

   // Plain logger (not LoggerToDb) — LoggerToDb depends on FeatureFlagService, so injecting
   // it here would create a circular dependency.
   private readonly logger = new Logger(FeatureFlagService.name);

   constructor(
      @InjectRepository(FeatureFlag) private readonly featureFlagRepo: Repository<FeatureFlag>,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
   ) { }

   public getFeatureFlags(namespace?: FeatureFlagNamespace): Promise<FeatureFlag[]> {
      return this.featureFlagRepo.find(namespace ? { where: { namespace } } : undefined);
   }

   public async getFeatureFlag(namespace: FeatureFlagNamespace, key: string): Promise<FeatureFlag> {
      // Check feature flag in cache
      const cacheKey = this.getFeatureFlagCacheKey(namespace, key);
      const cachedFlag = await this.redis.get(cacheKey);
      if (cachedFlag) {
         this.inrementFeatureFlagTriggerCount(namespace, key, true);
         return JSON.parse(cachedFlag);
      }

      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key } });
      if (flag) {
         // TTL so flags toggled directly in the DB (bypassing enable/disableFeatureFlag,
         // which would otherwise invalidate this key) become visible within the window.
         await this.redis.set(cacheKey, JSON.stringify(flag), "EX", FeatureFlagService.CACHE_TTL_SECONDS);
         this.inrementFeatureFlagTriggerCount(namespace, key, false);
      } else {
         // Create it so we can disabled/enable it in the frontend
         await this.createFeatureFlag({ namespace, key });
      }
      return flag;
   }

   public async enableFeatureFlag(namespace: FeatureFlagNamespace, key: string): Promise<void | never> {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key } });
      if (!flag) {
         throw new Error(`Feature flag ${namespace}::${key} not found`);
      }
      flag.enabled = true;
      await this.featureFlagRepo.save(flag);
      await this.redis.del(this.getFeatureFlagCacheKey(namespace, key));

      await this.invokeEventListeners(namespace, key, true);
   }

   public async disableFeatureFlag(namespace: FeatureFlagNamespace, key: string): Promise<void | never> {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key } });
      if (!flag) {
         throw new Error(`Feature flag ${namespace}::${key} not found`);
      }
      flag.enabled = false;
      await this.featureFlagRepo.save(flag);
      await this.redis.del(this.getFeatureFlagCacheKey(namespace, key));

      await this.invokeEventListeners(namespace, key, false);
   }

   public async createFeatureFlag(request: CreateFeatureFlagRequest): Promise<void | never> {
      await this.featureFlagRepo.upsert(
         { namespace: request.namespace, key: request.key, payload: request.payload, description: request.description, enabled: false },
         { conflictPaths: ["namespace", "key"], skipUpdateIfNoValuesChanged: true },
      );
   }

   public async deleteFeatureFlag(namespace: FeatureFlagNamespace, key: string) {
      await this.featureFlagRepo.delete({ namespace, key });
      await this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async updateFeatureFlag(namespace: FeatureFlagNamespace, key: string, request: UpdateFeatureFlagRequest) {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key: key } });
      if (!flag) {
         throw new Error(`Feature flag ${namespace}::${key} not found`);
      }
      flag.payload = request.payload;
      flag.description = request.description;

      await this.featureFlagRepo.save(flag);
      await this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async isFeatureFlagEnabled(namespace: FeatureFlagNamespace, key: string): Promise<boolean> {
      const flag = await this.getFeatureFlag(namespace, key);
      return flag?.enabled ?? false;
   }

   public async isFeatureFlagDisabled(namespace: FeatureFlagNamespace, key: string): Promise<boolean> {
      return !(await this.isFeatureFlagEnabled(namespace, key));
   }

   public addEventListener(namespace: FeatureFlagNamespace, key: string, eventListenerId: string, func: FeatureFlagEventListener) {
      this.eventListeners[`${namespace}::${key}`] ??= [];
      this.eventListeners[`${namespace}::${key}`].push({ listenerId: eventListenerId, listener: func });
   }

   public removeEventListener(namespace: FeatureFlagNamespace, key: string, eventListenerId: string) {
      if (this.eventListeners[`${namespace}::${key}`]) {
         this.eventListeners[`${namespace}::${key}`] = this.eventListeners[`${namespace}::${key}`].filter(x => x.listenerId !== eventListenerId);

         if (this.eventListeners[`${namespace}::${key}`].length === 0) {
            delete this.eventListeners[`${namespace}::${key}`];
         }
      }
   }

   private async invokeEventListeners(namespace: FeatureFlagNamespace, key: string, value: boolean) {
      for (const e of this.eventListeners[`${namespace}::${key}`] ?? []) {
         this.logger.log(`Invoking event listener ${e.listenerId} for feature flag ${namespace}::${key}`);
         try {
            await e.listener(value);
         } catch (err) {
            this.logger.error(`Event listener ${e.listenerId} failed for feature flag ${namespace}::${key}: ${err}`);
         }
      }
   }

   private getFeatureFlagCacheKey(namespace: FeatureFlagNamespace, key: string): string {
      return `feature_flag:${namespace}:${key}`;
   }

   private inrementFeatureFlagTriggerCount(namespace: FeatureFlagNamespace, key: string, cached: boolean): void {
      // Fire-and-forget telemetry; failures should not affect the flag lookup.
      void this.featureFlagRepo
         .increment({ namespace, key }, `${cached ? "cached" : "db"}_trigger_count`, 1)
         .catch((e) => this.logger.error(`Failed to increment trigger count for ${namespace}::${key}: ${e}`));
   }
}
