/**
 * Parsing of GitHub `push` webhook payloads into the commit metadata a pipeline
 * run records, plus the decision of whether a payload should trigger a run.
 *
 * Kept free of Nest so it can be unit tested directly.
 */

/** The subset of the GitHub push payload we care about. */
export interface GithubPushPayload {
   ref?: string;
   before?: string;
   after?: string;
   created?: boolean;
   deleted?: boolean;
   forced?: boolean;
   /** Branch a tag was cut from, present on tag pushes. */
   base_ref?: string | null;
   compare?: string;
   repository?: {
      full_name?: string;
      html_url?: string;
      default_branch?: string;
   };
   pusher?: { name?: string | null; email?: string | null };
   sender?: { login?: string | null };
   commits?: GithubCommit[];
   head_commit?: GithubCommit | null;
}

export interface GithubCommit {
   id?: string;
   tree_id?: string;
   message?: string;
   timestamp?: string;
   url?: string;
   author?: { name?: string; email?: string; username?: string };
   committer?: { name?: string; email?: string; username?: string };
   added?: string[];
   removed?: string[];
   modified?: string[];
}

export type GitRefType = "branch" | "tag" | "unknown";

/** Normalised commit metadata stored on a run and rendered as the "built commit". */
export interface BuiltCommitInfo {
   sha: string | null;
   /** Short display form, 12 chars — long enough to be unambiguous in practice. */
   shortSha: string | null;
   message: string | null;
   url: string | null;
   authorName: string | null;
   authorUsername: string | null;
   committedAt: Date | null;
   ref: string | null;
   refName: string | null;
   refType: GitRefType;
   repository: string | null;
   compareUrl: string | null;
   /** Union of added/removed/modified paths across the pushed commits. */
   changedFiles: string[];
   /** Who pushed, as reported by GitHub (may be a bot). */
   pushedBy: string | null;
}

/** Cap the stored file list so a huge push cannot bloat the row. */
const MAX_CHANGED_FILES = 200;

export function shortenSha(sha: string | null | undefined, length = 12): string | null {
   if (!sha) return null;
   const trimmed = sha.trim();
   if (!trimmed || /^0+$/.test(trimmed)) return null;
   return trimmed.slice(0, length);
}

/** `refs/heads/master` → branch/master, `refs/tags/v3.0.90` → tag/v3.0.90. */
export function parseRef(ref: string | null | undefined): { type: GitRefType; name: string | null } {
   if (!ref) return { type: "unknown", name: null };
   if (ref.startsWith("refs/heads/")) return { type: "branch", name: ref.slice("refs/heads/".length) };
   if (ref.startsWith("refs/tags/")) return { type: "tag", name: ref.slice("refs/tags/".length) };
   return { type: "unknown", name: ref };
}

/**
 * Translates a shell-style glob (`v*`, `release-*.*`) into an anchored regex.
 * An empty pattern matches everything.
 */
export function matchesGlob(pattern: string | null | undefined, value: string): boolean {
   const trimmed = (pattern ?? "").trim();
   if (!trimmed) return true;
   const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
   try {
      return new RegExp(`^${escaped}$`).test(value);
   } catch {
      return false;
   }
}

/** Extracts the commit metadata from a push payload. */
export function extractBuiltCommit(payload: GithubPushPayload): BuiltCommitInfo {
   const head = payload.head_commit ?? null;
   const { type, name } = parseRef(payload.ref);
   const sha = shortenSha(head?.id ?? payload.after, 40);

   // Prefer the union across all pushed commits; a multi-commit push touches more
   // than head_commit alone reports. Tag pushes carry an empty `commits` array,
   // in which case head_commit is all we have.
   const commits = payload.commits?.length ? payload.commits : head ? [head] : [];
   const files = new Set<string>();
   for (const commit of commits) {
      for (const path of [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]) {
         if (files.size >= MAX_CHANGED_FILES) break;
         files.add(path);
      }
   }

   let committedAt: Date | null = null;
   if (head?.timestamp) {
      const parsed = new Date(head.timestamp);
      if (!Number.isNaN(parsed.getTime())) committedAt = parsed;
   }

   return {
      sha,
      shortSha: shortenSha(sha),
      message: head?.message?.trim() || null,
      url: head?.url || null,
      authorName: head?.author?.name || null,
      authorUsername: head?.author?.username || null,
      committedAt,
      ref: payload.ref || null,
      refName: name,
      refType: type,
      repository: payload.repository?.full_name || null,
      compareUrl: payload.compare || null,
      changedFiles: [...files],
      pushedBy: payload.pusher?.name || payload.sender?.login || null,
   };
}

export interface TriggerRules {
   /** Branch pushes to this branch trigger a run. */
   branch: string;
   /** When true, tag pushes trigger a run as well. */
   triggerOnTags: boolean;
   /** Glob the tag name must match; empty means any tag. */
   tagPattern?: string | null;
}

export type TriggerDecision =
   | { trigger: true; reason: string }
   | { trigger: false; reason: string };

/**
 * Decides whether a push should start a run.
 *
 * Branch pushes must be on the configured branch. Tag pushes are accepted when
 * `triggerOnTags` is set and the tag matches `tagPattern` — this is the common
 * release shape, where CI pushes an annotated tag (`refs/tags/v3.0.90`) rather
 * than committing to the branch, so a branch-only rule never fires.
 * Ref deletions never trigger.
 */
export function shouldTrigger(payload: GithubPushPayload, rules: TriggerRules): TriggerDecision {
   if (payload.deleted) {
      return { trigger: false, reason: "Ref was deleted, ignoring" };
   }

   const { type, name } = parseRef(payload.ref);

   if (type === "branch") {
      if (name !== rules.branch) {
         return { trigger: false, reason: `Not a push to ${rules.branch} (got ${name ?? payload.ref}), ignoring` };
      }
      return { trigger: true, reason: `Push to ${rules.branch}` };
   }

   if (type === "tag") {
      if (!rules.triggerOnTags) {
         return { trigger: false, reason: `Tag pushes are disabled for this pipeline (${name}), ignoring` };
      }
      if (!matchesGlob(rules.tagPattern, name ?? "")) {
         return { trigger: false, reason: `Tag ${name} does not match pattern "${rules.tagPattern}", ignoring` };
      }
      return { trigger: true, reason: `Tag ${name}` };
   }

   return { trigger: false, reason: `Unsupported ref ${payload.ref ?? "(none)"}, ignoring` };
}

/** True when the commit message opts out of deployment. */
export function hasSkipDirective(message: string | null | undefined): boolean {
   if (!message) return false;
   return /\[skip deploy\]/i.test(message);
}

/**
 * Label shown as the run's revision. Prefers the tag (a release name is more
 * meaningful than a hash), then the short sha, then a timestamp fallback.
 */
export function buildRevisionLabel(commit: BuiltCommitInfo, fallback: string): string {
   if (commit.refType === "tag" && commit.refName) return commit.refName;
   if (commit.shortSha) return commit.shortSha;
   return fallback;
}
