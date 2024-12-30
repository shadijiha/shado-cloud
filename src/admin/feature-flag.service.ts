import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type Redis from "ioredis";
import { FeatureFlag, FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { REDIS_CACHE } from "src/util";
import { Repository } from "typeorm";
import { CreateFeatureFlagRequest, UpdateFeatureFlagRequest } from "./adminApiTypes";

@Injectable()
export class FeatureFlagService {
   constructor(
      @InjectRepository(FeatureFlag) private readonly featureFlagRepo: Repository<FeatureFlag>,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
   ) {}

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
         await this.redis.set(cacheKey, JSON.stringify(flag));
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
      this.featureFlagRepo.save(flag);
      this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async disableFeatureFlag(namespace: FeatureFlagNamespace, key: string): Promise<void | never> {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key } });
      if (!flag) {
         throw new Error(`Feature flag ${namespace}::${key} not found`);
      }
      flag.enabled = false;
      this.featureFlagRepo.save(flag);
      this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async createFeatureFlag(request: CreateFeatureFlagRequest): Promise<void | never> {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace: request.namespace, key: request.key } });
      if (flag) {
         throw new Error(`Feature flag ${request.namespace}::${request.key} already exists`);
      }

      await this.featureFlagRepo.save({ ...request, enabled: false });
   }

   public async deleteFeatureFlag(namespace: FeatureFlagNamespace, key: string) {
      await this.featureFlagRepo.delete({ namespace, key });
      this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async updateFeatureFlag(namespace: FeatureFlagNamespace, key: string, request: UpdateFeatureFlagRequest) {
      const flag = await this.featureFlagRepo.findOne({ where: { namespace, key: key } });
      if (!flag) {
         throw new Error(`Feature flag ${namespace}::${key} not found`);
      }
      flag.payload = request.payload;
      flag.description = request.description;

      await this.featureFlagRepo.save(flag);
      this.redis.del(this.getFeatureFlagCacheKey(namespace, key));
   }

   public async isFeatureFlagEnabled(namespace: FeatureFlagNamespace, key: string): Promise<boolean> {
      const flag = await this.getFeatureFlag(namespace, key);
      return flag?.enabled ?? false;
   }

   public async isFeatureFlagDisabled(namespace: FeatureFlagNamespace, key: string): Promise<boolean> {
      return !(await this.isFeatureFlagEnabled(namespace, key));
   }

   private getFeatureFlagCacheKey(namespace: FeatureFlagNamespace, key: string): string {
      return `feature_flag:${namespace}:${key}`;
   }

   private inrementFeatureFlagTriggerCount(namespace: FeatureFlagNamespace, key: string, cached: boolean): void {
      this.featureFlagRepo.increment({ namespace, key }, `${cached ? "cached" : "db"}_trigger_count`, 1);
   }
}
