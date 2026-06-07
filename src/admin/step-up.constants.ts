/**
 * Reusable "step-up" 2FA gate.
 *
 * Sensitive admin features require a recent TOTP verification. After a valid
 * code, the user is granted access to a SCOPE for {@link STEP_UP_TTL_SECONDS}.
 * Add a new scope here and you can guard any endpoint/gateway with it.
 */
export const STEP_UP_SCOPES = ["remote", "database", "redis"] as const;
export type StepUpScope = (typeof STEP_UP_SCOPES)[number];

export function isStepUpScope(value: string): value is StepUpScope {
   return (STEP_UP_SCOPES as readonly string[]).includes(value);
}

/** How long a step-up grant remains valid after a successful 2FA check. */
export const STEP_UP_TTL_SECONDS = 60 * 60; // 60 minutes

/** Metadata key used by @Require2fa() / TwoFactorGuard. */
export const REQUIRE_2FA_KEY = "require_2fa_scope";
