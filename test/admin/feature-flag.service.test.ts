import { Test, type TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { type Repository } from "typeorm";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { FeatureFlag, FeatureFlagNamespace } from "src/models/admin/featureFlag";
import { REDIS_CACHE } from "src/util";

describe("FeatureFlagService - event listeners", () => {
   let service: FeatureFlagService;
   let featureFlagRepo: Repository<FeatureFlag>;
   let redis: { del: jest.Mock };

   const NAMESPACE = FeatureFlagNamespace.Files;
   const KEY = "tiered_storage";

   beforeEach(async () => {
      redis = { del: jest.fn().mockResolvedValue(1) };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            FeatureFlagService,
            {
               provide: getRepositoryToken(FeatureFlag),
               useValue: {
                  // findOne returns an existing flag so enable/disable don't throw
                  findOne: jest.fn().mockResolvedValue({ namespace: NAMESPACE, key: KEY, enabled: false }),
                  save: jest.fn().mockResolvedValue(undefined),
               },
            },
            { provide: REDIS_CACHE, useValue: redis },
         ],
      }).compile();

      service = module.get<FeatureFlagService>(FeatureFlagService);
      featureFlagRepo = module.get(getRepositoryToken(FeatureFlag));
   });

   afterEach(() => jest.clearAllMocks());

   it("invokes a registered listener with `true` when the flag is enabled", async () => {
      const listener = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "listener-1", listener);

      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
   });

   it("invokes a registered listener with `false` when the flag is disabled", async () => {
      const listener = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "listener-1", listener);

      await service.disableFeatureFlag(NAMESPACE, KEY);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(false);
   });

   it("persists the flag and clears the cache before notifying listeners", async () => {
      const order: string[] = [];
      (featureFlagRepo.save as jest.Mock).mockImplementation(async () => { order.push("save"); });
      redis.del.mockImplementation(async () => { order.push("del"); });
      const listener = jest.fn().mockImplementation(async () => { order.push("listener"); });
      service.addEventListener(NAMESPACE, KEY, "listener-1", listener);

      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(order).toEqual(["save", "del", "listener"]);
   });

   it("does not invoke listeners registered for a different namespace/key", async () => {
      const listener = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(FeatureFlagNamespace.Admin, "some_other_flag", "listener-1", listener);

      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(listener).not.toHaveBeenCalled();
   });

   it("invokes every listener registered for the same key", async () => {
      const a = jest.fn().mockResolvedValue(undefined);
      const b = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "listener-a", a);
      service.addEventListener(NAMESPACE, KEY, "listener-b", b);

      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(a).toHaveBeenCalledWith(true);
      expect(b).toHaveBeenCalledWith(true);
   });

   it("stops invoking a listener after it is removed", async () => {
      const listener = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "listener-1", listener);
      service.removeEventListener(NAMESPACE, KEY, "listener-1");

      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(listener).not.toHaveBeenCalled();
   });

   it("only removes the listener matching the given id", async () => {
      const keep = jest.fn().mockResolvedValue(undefined);
      const drop = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "keep", keep);
      service.addEventListener(NAMESPACE, KEY, "drop", drop);

      service.removeEventListener(NAMESPACE, KEY, "drop");
      await service.enableFeatureFlag(NAMESPACE, KEY);

      expect(keep).toHaveBeenCalledWith(true);
      expect(drop).not.toHaveBeenCalled();
   });

   it("removeEventListener is a no-op for an unknown key", () => {
      expect(() => service.removeEventListener(NAMESPACE, "never_registered", "x")).not.toThrow();
   });

   it("isolates listener failures: one throwing listener does not stop the others and does not reject", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const failing = jest.fn().mockRejectedValue(new Error("boom"));
      const after = jest.fn().mockResolvedValue(undefined);
      service.addEventListener(NAMESPACE, KEY, "failing", failing);
      service.addEventListener(NAMESPACE, KEY, "after", after);

      await expect(service.enableFeatureFlag(NAMESPACE, KEY)).resolves.not.toThrow();

      expect(failing).toHaveBeenCalled();
      expect(after).toHaveBeenCalledWith(true);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failing"));
      errorSpy.mockRestore();
   });

   it("throws when enabling a flag that does not exist", async () => {
      (featureFlagRepo.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.enableFeatureFlag(NAMESPACE, "missing")).rejects.toThrow(
         `Feature flag ${NAMESPACE}::missing not found`,
      );
   });
});
