import {
   BlockerConfig,
   BlockerKind,
   PromotionKind,
   PromotionState,
   StageKind,
   TargetKind,
   WaveKind,
} from "src/models/admin/pipeline/pipeline.types";

/**
 * Declarative description of a whole pipeline. Blueprints are how built-in
 * pipelines are seeded and how the "create from template" action in the UI works
 * — a single object graph that {@link PipelineService.createFromBlueprint}
 * materialises into rows.
 *
 * Keys (`key`) are local identifiers used to wire promotions to stages; they are
 * not persisted.
 */
export interface PipelineBlueprint {
   slug: string;
   name: string;
   description?: string;
   workDir?: string;
   branch?: string;
   pm2ProcessName?: string | null;
   owner?: string;
   waves?: WaveBlueprint[];
   stages: StageBlueprint[];
   promotions?: PromotionBlueprint[];
}

export interface WaveBlueprint {
   key: string;
   name: string;
   kind: WaveKind;
   position?: number;
   bakeTimeMinutes?: number;
   staggerMinutes?: number;
   accentColor?: string;
}

export interface StageBlueprint {
   key: string;
   name: string;
   kind: StageKind;
   /** `key` of the wave this stage belongs to. */
   wave?: string;
   position?: number;
   isProd?: boolean;
   description?: string;
   targets: TargetBlueprint[];
   approvalWorkflow?: WorkflowBlueprint;
}

export interface TargetBlueprint {
   name: string;
   kind: TargetKind;
   cmd?: string;
   args?: string[];
   workDir?: string;
   url?: string;
   triggersRestart?: boolean;
   maxAttempts?: number;
   timeoutMs?: number;
}

export interface WorkflowBlueprint {
   name: string;
   rollbackOnFailure?: boolean;
   requiresConsistentRevisions?: boolean;
   steps: WorkflowStepBlueprint[];
}

export interface WorkflowStepBlueprint {
   name: string;
   manual?: boolean;
   cmd?: string;
   args?: string[];
   workDir?: string;
   dependencies?: string[];
   maxAttempts?: number;
   timeoutMs?: number;
}

export interface PromotionBlueprint {
   /** `key` of the source stage; omit for the pipeline entry promotion. */
   from?: string;
   /** `key` of the destination stage. */
   to: string;
   kind: PromotionKind;
   state?: PromotionState;
   requiresApproval?: boolean;
   approvalName?: string;
   blockers?: BlockerBlueprint[];
}

export interface BlockerBlueprint {
   kind: BlockerKind;
   name: string;
   description?: string;
   config?: BlockerConfig | Record<string, unknown>;
}

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * The API's own release pipeline: pull sources, build the artifact, gate on the
 * approval workflow (tests + lint), then migrate/restart/verify as one wave.
 */
const BACKEND_BLUEPRINT: PipelineBlueprint = {
   slug: "backend",
   name: "Backend",
   description: "shado-cloud API release pipeline",
   workDir: "__CWD__",
   branch: "master",
   pm2ProcessName: "shado-cloud-backend",
   waves: [
      { key: "build", name: "Build", kind: WaveKind.Exclusive, position: 0, accentColor: "#0972d3" },
      { key: "release", name: "Release", kind: WaveKind.Exclusive, position: 1, bakeTimeMinutes: 0, accentColor: "#037f0c" },
   ],
   stages: [
      {
         key: "packages",
         name: "Packages",
         kind: StageKind.Packages,
         wave: "build",
         description: "Source repositories watched for changes",
         targets: [{ name: "shado-cloud/master", kind: TargetKind.Package, cmd: "git", args: ["pull"] }],
      },
      {
         key: "versionset",
         name: "VersionSet",
         kind: StageKind.VersionSet,
         wave: "build",
         description: "Install dependencies and compile the artifact",
         targets: [
            { name: "npm install", kind: TargetKind.VersionSet, cmd: "npm", args: ["install"], timeoutMs: TEN_MINUTES },
            { name: "build", kind: TargetKind.VersionSet, cmd: "npm", args: ["run", "build"], timeoutMs: TEN_MINUTES },
         ],
         approvalWorkflow: {
            name: "VersionSet Approval",
            rollbackOnFailure: false,
            steps: [
               { name: "Unit Tests", cmd: "npm", args: ["test", "--", "--runInBand", "--no-colors"], timeoutMs: TEN_MINUTES },
               { name: "Lint", cmd: "npm", args: ["run", "lint:ci"], timeoutMs: TEN_MINUTES },
            ],
         },
      },
      {
         key: "migrate",
         name: "Migrate",
         kind: StageKind.Deployable,
         wave: "release",
         isProd: true,
         description: "Apply pending database migrations",
         targets: [
            {
               name: "typeorm migration:run",
               kind: TargetKind.Environment,
               cmd: "npx",
               args: ["typeorm", "migration:run", "-d", "ormconfig.js"],
               timeoutMs: TEN_MINUTES,
            },
         ],
      },
      {
         key: "restart",
         name: "Restart",
         kind: StageKind.Deployable,
         wave: "release",
         isProd: true,
         description: "Restart the API process; the run resumes after boot",
         targets: [
            {
               name: "pm2 restart",
               kind: TargetKind.Environment,
               cmd: "pm2",
               args: ["restart", "shado-cloud-backend"],
               triggersRestart: true,
            },
         ],
      },
      {
         key: "verify",
         name: "Verify",
         kind: StageKind.Deployable,
         wave: "release",
         isProd: true,
         description: "Post-restart health verification",
         targets: [{ name: "pm2 jlist", kind: TargetKind.Environment, cmd: "pm2", args: ["jlist"] }],
      },
   ],
   promotions: [
      { from: "packages", to: "versionset", kind: PromotionKind.BuildPackage, state: PromotionState.On },
      {
         from: "versionset",
         to: "migrate",
         kind: PromotionKind.DeployVersionSet,
         state: PromotionState.On,
         requiresApproval: true,
         approvalName: "VersionSet Approval",
      },
      { from: "migrate", to: "restart", kind: PromotionKind.PromoteEnv, state: PromotionState.On },
      { from: "restart", to: "verify", kind: PromotionKind.PromoteEnv, state: PromotionState.On },
   ],
};

const FRONTEND_BLUEPRINT: PipelineBlueprint = {
   slug: "frontend",
   name: "Frontend",
   description: "shado-cloud-frontend release pipeline",
   workDir: "",
   branch: "master",
   pm2ProcessName: null,
   waves: [{ key: "build", name: "Build", kind: WaveKind.Exclusive, position: 0, accentColor: "#0972d3" }],
   stages: [
      {
         key: "packages",
         name: "Packages",
         kind: StageKind.Packages,
         wave: "build",
         targets: [{ name: "shado-cloud-frontend/master", kind: TargetKind.Package, cmd: "git", args: ["pull"] }],
      },
      {
         key: "versionset",
         name: "VersionSet",
         kind: StageKind.VersionSet,
         wave: "build",
         targets: [
            { name: "npm install", kind: TargetKind.VersionSet, cmd: "npm", args: ["install"], timeoutMs: TEN_MINUTES },
            { name: "build", kind: TargetKind.VersionSet, cmd: "npm", args: ["run", "build"], timeoutMs: TEN_MINUTES },
         ],
      },
   ],
   promotions: [{ from: "packages", to: "versionset", kind: PromotionKind.BuildPackage, state: PromotionState.On }],
};

/**
 * A harmless reference pipeline that exercises every feature of the model —
 * waves with bake/stagger pacing, a parallel approval workflow with a manual
 * gate, a time-window blocker, an alarm blocker and a disabled promotion.
 * Useful for validating the UI without touching a real deployment.
 */
const REFERENCE_BLUEPRINT: PipelineBlueprint = {
   slug: "reference",
   name: "Reference pipeline",
   description: "Demonstrates waves, approval workflows and promotion blockers. Safe to run — every target only echoes.",
   workDir: "__CWD__",
   branch: "never",
   owner: "platform",
   waves: [
      { key: "build", name: "Build", kind: WaveKind.Exclusive, position: 0, accentColor: "#0972d3" },
      { key: "preprod", name: "Wave 1 — Pre-production", kind: WaveKind.Exclusive, position: 1, bakeTimeMinutes: 0, accentColor: "#8b5cf6" },
      { key: "prod", name: "Wave 2 — Production", kind: WaveKind.Staggered, position: 2, staggerMinutes: 0, accentColor: "#037f0c" },
   ],
   stages: [
      {
         key: "packages",
         name: "Packages",
         kind: StageKind.Packages,
         wave: "build",
         targets: [
            { name: "ServiceCore/mainline", kind: TargetKind.Package, cmd: "echo", args: ["fetched ServiceCore"] },
            { name: "ServiceApi/mainline", kind: TargetKind.Package, cmd: "echo", args: ["fetched ServiceApi"] },
         ],
      },
      {
         key: "versionset",
         name: "VersionSet",
         kind: StageKind.VersionSet,
         wave: "build",
         targets: [{ name: "service/release", kind: TargetKind.VersionSet, cmd: "echo", args: ["built version set"] }],
         approvalWorkflow: {
            name: "VersionSet Approval",
            steps: [
               { name: "Unit Tests", cmd: "echo", args: ["unit tests passed"] },
               { name: "Integration Tests", cmd: "echo", args: ["integration tests passed"] },
               { name: "Package Audit", cmd: "echo", args: ["audit clean"], dependencies: ["Unit Tests"] },
            ],
         },
      },
      {
         key: "alpha",
         name: "Alpha",
         kind: StageKind.Deployable,
         wave: "preprod",
         targets: [{ name: "service/alpha", kind: TargetKind.Environment, cmd: "echo", args: ["deployed to alpha"] }],
      },
      {
         key: "beta",
         name: "Beta",
         kind: StageKind.Deployable,
         wave: "preprod",
         targets: [{ name: "service/beta", kind: TargetKind.Environment, cmd: "echo", args: ["deployed to beta"] }],
         approvalWorkflow: {
            name: "Beta Approval",
            rollbackOnFailure: true,
            steps: [
               { name: "Smoke Tests", cmd: "echo", args: ["smoke tests passed"] },
               { name: "Canary Bake", cmd: "echo", args: ["canary healthy"], dependencies: ["Smoke Tests"] },
               { name: "Release Manager Sign-off", manual: true, dependencies: ["Canary Bake"] },
            ],
         },
      },
      {
         key: "prod-eu",
         name: "Prod EU",
         kind: StageKind.Deployable,
         wave: "prod",
         isProd: true,
         targets: [{ name: "service/eu-west-1", kind: TargetKind.Environment, cmd: "echo", args: ["deployed to eu-west-1"] }],
      },
      {
         key: "prod-us",
         name: "Prod US",
         kind: StageKind.Deployable,
         wave: "prod",
         isProd: true,
         targets: [{ name: "service/us-east-1", kind: TargetKind.Environment, cmd: "echo", args: ["deployed to us-east-1"] }],
      },
   ],
   promotions: [
      { from: "packages", to: "versionset", kind: PromotionKind.BuildPackage, state: PromotionState.On },
      {
         from: "versionset",
         to: "alpha",
         kind: PromotionKind.DeployVersionSet,
         state: PromotionState.On,
         requiresApproval: true,
         approvalName: "VersionSet Approval",
      },
      { from: "alpha", to: "beta", kind: PromotionKind.PromoteEnv, state: PromotionState.On },
      {
         from: "beta",
         to: "prod-eu",
         kind: PromotionKind.PromoteEnv,
         state: PromotionState.On,
         requiresApproval: true,
         approvalName: "Beta Approval",
         blockers: [
            {
               kind: BlockerKind.TimeWindow,
               name: "Business hours only",
               description: "Production promotions are only allowed Mon–Thu during business hours",
               config: { daysOfWeek: [1, 2, 3, 4], startTime: "09:00", endTime: "16:00" },
            },
            {
               kind: BlockerKind.Alarm,
               name: "service-availability-eu",
               description: "Blocks promotion while the regional availability monitor is firing",
               config: { monitor: "service-availability-eu" },
            },
         ],
      },
      {
         from: "prod-eu",
         to: "prod-us",
         kind: PromotionKind.PromoteEnv,
         state: PromotionState.On,
         blockers: [
            {
               kind: BlockerKind.ManualApproval,
               name: "US rollout sign-off",
               description: "A human must confirm the EU rollout looks healthy",
               config: { prompt: "Confirm the EU region is healthy before rolling out to US" },
            },
         ],
      },
   ],
};

export const DEFAULT_PIPELINE_BLUEPRINTS: PipelineBlueprint[] = [
   BACKEND_BLUEPRINT,
   FRONTEND_BLUEPRINT,
   REFERENCE_BLUEPRINT,
];

/** Blueprints offered in the "create from template" picker, keyed by id. */
export const PIPELINE_TEMPLATES: Record<string, PipelineBlueprint> = {
   backend: BACKEND_BLUEPRINT,
   frontend: FRONTEND_BLUEPRINT,
   reference: REFERENCE_BLUEPRINT,
   blank: {
      slug: "new-pipeline",
      name: "New pipeline",
      workDir: "__CWD__",
      branch: "master",
      stages: [
         {
            key: "source",
            name: "Source",
            kind: StageKind.Packages,
            targets: [{ name: "repository", kind: TargetKind.Package, cmd: "git", args: ["pull"] }],
         },
         {
            key: "build",
            name: "Build",
            kind: StageKind.VersionSet,
            targets: [{ name: "build", kind: TargetKind.VersionSet, cmd: "npm", args: ["run", "build"] }],
         },
      ],
      promotions: [{ from: "source", to: "build", kind: PromotionKind.BuildPackage, state: PromotionState.On }],
   },
};

/**
 * Converts a legacy flat deployment project (a slug + an ordered list of
 * `{ step, name, cmd, args, triggersRestart, skip }`) into a pipeline blueprint.
 *
 * Each legacy step becomes its own stage with a single target, so an existing
 * installation immediately sees its real deployment rendered as a pipeline.
 * Steps are split into a "Build" wave and a "Release" wave at the first step
 * that restarts the process, which is where a flat deployment effectively
 * crosses from building to releasing.
 */
export function blueprintFromLegacyProject(project: {
   slug: string;
   name: string;
   workDir: string;
   branch: string;
   pm2ProcessName: string | null;
   steps: { step: string; name: string; cmd: string; args: string[]; triggersRestart?: boolean; skip?: boolean }[];
}): PipelineBlueprint {
   const restartIndex = project.steps.findIndex((s) => s.triggersRestart);
   const releaseFrom = restartIndex === -1 ? project.steps.length : restartIndex;

   const stages: StageBlueprint[] = project.steps.map((step, index) => {
      const inRelease = index >= releaseFrom;
      return {
         key: step.step,
         name: step.name || step.step,
         kind: inRelease ? StageKind.Deployable : index === 0 ? StageKind.Packages : StageKind.VersionSet,
         wave: inRelease ? "release" : "build",
         position: index,
         isProd: inRelease,
         targets: [
            {
               name: step.step,
               kind: inRelease ? TargetKind.Environment : index === 0 ? TargetKind.Package : TargetKind.VersionSet,
               cmd: step.cmd,
               args: step.args ?? [],
               triggersRestart: step.triggersRestart ?? false,
            },
         ],
      };
   });

   const promotions: PromotionBlueprint[] = stages.slice(1).map((stage, index) => ({
      from: stages[index].key,
      to: stage.key,
      kind: index === 0 ? PromotionKind.BuildPackage : PromotionKind.PromoteEnv,
      state: PromotionState.On,
   }));

   const waves: WaveBlueprint[] = [{ key: "build", name: "Build", kind: WaveKind.Exclusive, position: 0, accentColor: "#0972d3" }];
   if (restartIndex !== -1) {
      waves.push({ key: "release", name: "Release", kind: WaveKind.Exclusive, position: 1, accentColor: "#037f0c" });
   }

   return {
      slug: project.slug,
      name: project.name,
      description: "Imported from the legacy flat deployment configuration",
      workDir: project.workDir,
      branch: project.branch,
      pm2ProcessName: project.pm2ProcessName,
      waves,
      stages,
      promotions,
   };
}
