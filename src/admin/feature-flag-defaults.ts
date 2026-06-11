import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

/**
 * Default JSON payload for the "Hot" tiered-storage flag. The payload is configurable
 * per-environment from the admin UI; these are the shipped defaults.
 *
 * - accessThreshold:        number of serves before a file is copied into Redis (the "hot" tier)
 * - ttlSeconds:             how long a cached blob lives in Redis; refreshed on every hot hit (sliding)
 * - maxFileBytes:           files larger than this are never cached in Redis
 * - frequencyWindowSeconds: TTL on the per-file access counter (so old, sporadic access decays away)
 */
export interface HotStorageConfig {
   accessThreshold: number;
   ttlSeconds: number;
   maxFileBytes: number;
   frequencyWindowSeconds: number;
}

export const HOT_STORAGE_DEFAULT_CONFIG: HotStorageConfig = {
   accessThreshold: 5,
   ttlSeconds: 60 * 60, // 1 hour
   maxFileBytes: 5 * 1024 * 1024, // 5 MB
   frequencyWindowSeconds: 30 * 60, // 30 min
};

/**
 * Default payload + description applied when a feature flag is first created, keyed by
 * `${namespace}::${key}`. Seeding a default payload means the shape of the configurable
 * JSON is visible to admins in the UI as soon as the flag appears.
 */
export const FEATURE_FLAG_DEFAULTS: Record<string, { payload: object; description: string }> = {
   [`${FeatureFlagNamespace.Files}::tiered_storage_hot`]: {
      payload: HOT_STORAGE_DEFAULT_CONFIG,
      description:
         "Hot tier: keep frequently-accessed files entirely in Redis and serve them from there. " +
         "Payload configures the promotion threshold, blob TTL, max cached file size, and access-counter window.",
   },
};

/** Returns the default payload (pretty JSON) for a flag, or undefined if none is registered. */
export function defaultPayloadFor(namespace: FeatureFlagNamespace, key: string): string | undefined {
   const entry = FEATURE_FLAG_DEFAULTS[`${namespace}::${key}`];
   return entry ? JSON.stringify(entry.payload, null, 2) : undefined;
}

/** Returns the default description for a flag, or undefined if none is registered. */
export function defaultDescriptionFor(namespace: FeatureFlagNamespace, key: string): string | undefined {
   return FEATURE_FLAG_DEFAULTS[`${namespace}::${key}`]?.description;
}
