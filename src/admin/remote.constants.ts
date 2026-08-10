import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

/**
 * Single feature flag gating remote access in the admin dashboard: the remote
 * terminal (RemoteTerminalGateway). Disabled by default (flags are created disabled).
 */
export const REMOTE_FLAG_NAMESPACE = FeatureFlagNamespace.Admin;
export const REMOTE_FLAG_KEY = "remote_access";
