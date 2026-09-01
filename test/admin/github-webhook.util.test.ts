import {
   buildRevisionLabel,
   extractBuiltCommit,
   hasSkipDirective,
   matchesGlob,
   parseRef,
   shouldTrigger,
   shortenSha,
   type GithubPushPayload,
} from "src/admin/pipelines/github-webhook.util";

/**
 * The real payload GitHub delivered for a release: a *tag* push created by
 * github-actions[bot], with an empty `commits` array and the detail in
 * `head_commit`.
 */
const TAG_PUSH: GithubPushPayload = {
   ref: "refs/tags/v3.0.90",
   before: "0000000000000000000000000000000000000000",
   after: "8c5948c23d0ba64ccbb5d2f119552703731d5e4f",
   created: true,
   deleted: false,
   forced: false,
   base_ref: "refs/heads/master",
   compare: "https://github.com/Shado-Cloud/shado-music-frontend/compare/v3.0.90",
   repository: {
      full_name: "Shado-Cloud/shado-music-frontend",
      html_url: "https://github.com/Shado-Cloud/shado-music-frontend",
      default_branch: "master",
   },
   pusher: { name: "github-actions[bot]", email: null },
   sender: { login: "github-actions[bot]" },
   commits: [],
   head_commit: {
      id: "8c5948c23d0ba64ccbb5d2f119552703731d5e4f",
      tree_id: "abb1b3d920a7ec5b3035edce6bd18500a1412f8d",
      message: "Update Player.svelte",
      timestamp: "2026-08-31T18:46:58-07:00",
      url: "https://github.com/Shado-Cloud/shado-music-frontend/commit/8c5948c23d0ba64ccbb5d2f119552703731d5e4f",
      author: {
         name: "Shadi Jiha",
         email: "51339220+shadijiha@users.noreply.github.com",
         username: "shadijiha",
      },
      committer: { name: "Shadi Jiha", username: "shadijiha" },
      added: [],
      removed: [],
      modified: ["src/components/Player.svelte"],
   },
};

const BRANCH_RULES = { branch: "master", triggerOnTags: true, tagPattern: "" };

describe("parseRef", () => {
   it("splits branch refs", () => {
      expect(parseRef("refs/heads/master")).toEqual({ type: "branch", name: "master" });
      expect(parseRef("refs/heads/feature/a-b")).toEqual({ type: "branch", name: "feature/a-b" });
   });

   it("splits tag refs", () => {
      expect(parseRef("refs/tags/v3.0.90")).toEqual({ type: "tag", name: "v3.0.90" });
   });

   it("reports anything else as unknown", () => {
      expect(parseRef("refs/pull/12/merge").type).toBe("unknown");
      expect(parseRef(undefined)).toEqual({ type: "unknown", name: null });
   });
});

describe("shortenSha", () => {
   it("shortens to 12 characters by default", () => {
      expect(shortenSha("8c5948c23d0ba64ccbb5d2f119552703731d5e4f")).toBe("8c5948c23d0b");
   });

   it("treats the all-zero sha as absent", () => {
      expect(shortenSha("0000000000000000000000000000000000000000")).toBeNull();
      expect(shortenSha("")).toBeNull();
      expect(shortenSha(undefined)).toBeNull();
   });
});

describe("matchesGlob", () => {
   it("matches everything when the pattern is empty", () => {
      expect(matchesGlob("", "v3.0.90")).toBe(true);
      expect(matchesGlob(undefined, "anything")).toBe(true);
   });

   it("supports * and ?", () => {
      expect(matchesGlob("v*", "v3.0.90")).toBe(true);
      expect(matchesGlob("v*", "release-1")).toBe(false);
      expect(matchesGlob("v?.0.0", "v1.0.0")).toBe(true);
      expect(matchesGlob("v?.0.0", "v12.0.0")).toBe(false);
   });

   it("anchors the pattern so a partial match is rejected", () => {
      expect(matchesGlob("v1", "v1.2")).toBe(false);
   });

   it("does not treat dots as wildcards", () => {
      expect(matchesGlob("v1.0", "v1x0")).toBe(false);
   });
});

describe("extractBuiltCommit", () => {
   it("pulls the full commit out of the real tag payload", () => {
      const commit = extractBuiltCommit(TAG_PUSH);

      expect(commit.sha).toBe("8c5948c23d0ba64ccbb5d2f119552703731d5e4f");
      expect(commit.shortSha).toBe("8c5948c23d0b");
      expect(commit.message).toBe("Update Player.svelte");
      expect(commit.url).toBe(
         "https://github.com/Shado-Cloud/shado-music-frontend/commit/8c5948c23d0ba64ccbb5d2f119552703731d5e4f",
      );
      expect(commit.authorName).toBe("Shadi Jiha");
      expect(commit.authorUsername).toBe("shadijiha");
      expect(commit.ref).toBe("refs/tags/v3.0.90");
      expect(commit.refName).toBe("v3.0.90");
      expect(commit.refType).toBe("tag");
      expect(commit.repository).toBe("Shado-Cloud/shado-music-frontend");
      expect(commit.compareUrl).toBe("https://github.com/Shado-Cloud/shado-music-frontend/compare/v3.0.90");
      expect(commit.pushedBy).toBe("github-actions[bot]");
      expect(commit.committedAt?.toISOString()).toBe("2026-09-01T01:46:58.000Z");
   });

   it("falls back to head_commit for changed files when commits is empty", () => {
      // Tag pushes carry `commits: []`, so head_commit is the only source.
      expect(extractBuiltCommit(TAG_PUSH).changedFiles).toEqual(["src/components/Player.svelte"]);
   });

   it("unions changed files across a multi-commit branch push", () => {
      const commit = extractBuiltCommit({
         ref: "refs/heads/master",
         commits: [
            { id: "a", added: ["one.ts"], modified: ["shared.ts"] },
            { id: "b", removed: ["two.ts"], modified: ["shared.ts"] },
         ],
         head_commit: { id: "b", message: "second" },
      });
      expect(commit.changedFiles.sort()).toEqual(["one.ts", "shared.ts", "two.ts"]);
   });

   it("falls back to `after` when head_commit is missing", () => {
      const commit = extractBuiltCommit({ ref: "refs/heads/master", after: "abcdef1234567890" });
      expect(commit.sha).toBe("abcdef1234567890");
      expect(commit.message).toBeNull();
   });

   it("ignores an unparseable timestamp rather than storing Invalid Date", () => {
      const commit = extractBuiltCommit({
         ref: "refs/heads/master",
         head_commit: { id: "a".repeat(40), timestamp: "not-a-date" },
      });
      expect(commit.committedAt).toBeNull();
   });
});

describe("shouldTrigger", () => {
   it("triggers on the real tag push — the case a branch-only rule missed", () => {
      const decision = shouldTrigger(TAG_PUSH, BRANCH_RULES);
      expect(decision.trigger).toBe(true);
      expect(decision.reason).toContain("v3.0.90");
   });

   it("ignores a tag push when tag triggering is off", () => {
      const decision = shouldTrigger(TAG_PUSH, { ...BRANCH_RULES, triggerOnTags: false });
      expect(decision.trigger).toBe(false);
      expect(decision.reason).toContain("disabled");
   });

   it("honours the tag pattern", () => {
      expect(shouldTrigger(TAG_PUSH, { ...BRANCH_RULES, tagPattern: "v*" }).trigger).toBe(true);
      const rejected = shouldTrigger(TAG_PUSH, { ...BRANCH_RULES, tagPattern: "release-*" });
      expect(rejected.trigger).toBe(false);
      expect(rejected.reason).toContain("does not match pattern");
   });

   it("triggers on a push to the configured branch", () => {
      expect(shouldTrigger({ ref: "refs/heads/master" }, BRANCH_RULES).trigger).toBe(true);
   });

   it("ignores a push to another branch", () => {
      const decision = shouldTrigger({ ref: "refs/heads/dev" }, BRANCH_RULES);
      expect(decision.trigger).toBe(false);
      expect(decision.reason).toContain("Not a push to master");
   });

   it("never triggers on a ref deletion", () => {
      expect(shouldTrigger({ ref: "refs/tags/v3.0.90", deleted: true }, BRANCH_RULES).trigger).toBe(false);
      expect(shouldTrigger({ ref: "refs/heads/master", deleted: true }, BRANCH_RULES).trigger).toBe(false);
   });

   it("ignores refs that are neither branches nor tags", () => {
      expect(shouldTrigger({ ref: "refs/pull/7/merge" }, BRANCH_RULES).trigger).toBe(false);
   });
});

describe("hasSkipDirective", () => {
   it("detects the directive case-insensitively", () => {
      expect(hasSkipDirective("chore: bump [skip deploy]")).toBe(true);
      expect(hasSkipDirective("chore: bump [SKIP DEPLOY]")).toBe(true);
      expect(hasSkipDirective("normal commit")).toBe(false);
      expect(hasSkipDirective(null)).toBe(false);
   });
});

describe("buildRevisionLabel", () => {
   it("prefers the tag name, which is more meaningful than a hash", () => {
      expect(buildRevisionLabel(extractBuiltCommit(TAG_PUSH), "fallback")).toBe("v3.0.90");
   });

   it("uses the short sha for branch pushes", () => {
      const commit = extractBuiltCommit({
         ref: "refs/heads/master",
         head_commit: { id: "8c5948c23d0ba64ccbb5d2f119552703731d5e4f" },
      });
      expect(buildRevisionLabel(commit, "fallback")).toBe("8c5948c23d0b");
   });

   it("falls back when nothing identifies the commit", () => {
      expect(buildRevisionLabel(extractBuiltCommit({}), "2026-09-01.123")).toBe("2026-09-01.123");
   });
});
