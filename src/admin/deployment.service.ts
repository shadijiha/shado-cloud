import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "child_process";
import { Subject } from "rxjs";
import { LoggerToDb } from "src/logging";
import { EnvVariables } from "src/config/config.validator";
import { EmailService } from "./email.service";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { DeploymentProject, DeploymentStepConfig } from "src/models/admin/deploymentProject";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface StepState {
   step: string;
   status: StepStatus;
   output: string;
   startedAt?: Date;
   finishedAt?: Date;
   error?: string;
   attempt?: number;
   maxAttempts?: number;
}

export interface DeploymentState {
   id: string;
   project: string;
   status: "running" | "success" | "failed";
   currentStep: StepState;
   completedSteps: Record<string, StepState>;
   startedAt: Date;
   finishedAt?: Date;
   triggeredBy: string;
}

interface DeploymentEvent {
   type: "step_start" | "step_output" | "step_complete" | "deployment_complete";
   step?: string;
   output?: string;
   status?: StepStatus;
   error?: string;
   startedAt?: Date;
   finishedAt?: Date;
   deployment?: DeploymentState;
   attempt?: number;
   maxAttempts?: number;
}

const REDIS_KEY_CURRENT = "deployment:current";
const REDIS_KEY_LAST = "deployment:last";

const DEFAULT_PROJECTS: Partial<DeploymentProject>[] = [
   {
      slug: "backend",
      name: "Backend",
      workDir: "__CWD__",
      pm2ProcessName: "shado-cloud-backend",
      branch: "master",
      steps: JSON.stringify([
         { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
         { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
         { step: "test", name: "Run Tests", cmd: "npm", args: ["test", "--", "--runInBand", "--no-colors"] },
         { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
         { step: "migrate", name: "Run Migrations", cmd: "npx", args: ["typeorm", "migration:run", "-d", "ormconfig.js"] },
         { step: "restart", name: "Restart Service", cmd: "pm2", args: ["restart", "shado-cloud-backend"], triggersRestart: true },
         { step: "verify", name: "Verify Deployment", cmd: "pm2", args: ["jlist"], runsOnModuleInit: true },
      ] as DeploymentStepConfig[]),
   },
   {
      slug: "frontend",
      name: "Frontend",
      workDir: "__FRONTEND_DEPLOY_PATH__",
      pm2ProcessName: null,
      branch: "master",
      steps: JSON.stringify([
         { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
         { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
         { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
      ] as DeploymentStepConfig[]),
   },
];

@Injectable()
export class DeploymentService implements OnModuleInit {
   private deploymentSubject: Subject<MessageEvent> | null = null;
   private currentProcess: ReturnType<typeof spawn> | null = null;
   private cancelled = false;

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly logger: LoggerToDb,
      private readonly emailService: EmailService,
      private readonly featureFlagService: FeatureFlagService,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      @InjectRepository(DeploymentProject) private readonly projectRepo: Repository<DeploymentProject>,
   ) {}

   async onModuleInit() {
      await this.seedDefaults();

      // Resume any in-progress deployment after restart (non-blocking)
      const deployment = await this.getState(REDIS_KEY_CURRENT);
      if (deployment?.status === "running") {
         const project = await this.projectRepo.findOneBy({ slug: deployment.project });
         if (!project) return;
         const step = deployment.currentStep;
         this.logger.log(`Resuming deployment ${step.step} after restart...`);
         this.cancelled = false;
         const remainingSteps = this.getFollowingSteps(step, project.getSteps());
         if (remainingSteps.length > 0) {
            deployment.currentStep = { step: remainingSteps[0].step, status: "running", output: "", startedAt: new Date() };
            await this.saveState(deployment, REDIS_KEY_CURRENT);
         }
         this.runSteps(remainingSteps, this.resolveWorkDir(project), deployment.project, deployment);
      }
   }

   private async seedDefaults() {
      for (const def of DEFAULT_PROJECTS) {
         const exists = await this.projectRepo.findOneBy({ slug: def.slug });
         if (!exists) {
            const project = this.projectRepo.create(def);
            await this.projectRepo.save(project);
            this.logger.log(`Seeded deployment project: ${def.slug}`);
         }
      }
   }

   private resolveWorkDir(project: DeploymentProject): string {
      if (project.workDir === "__CWD__") return process.cwd();
      if (project.workDir === "__FRONTEND_DEPLOY_PATH__") return this.config.get("FRONTEND_DEPLOY_PATH") || "";
      return project.workDir;
   }

   // --- State management ---

   private async saveState(deployment: DeploymentState | null, key: string) {
      if (deployment) {
         await this.redis.set(key, JSON.stringify(deployment), "EX", 86400);
      } else {
         await this.redis.del(key);
      }
   }

   private async getState(key: string): Promise<DeploymentState | null> {
      const data = await this.redis.get(key);
      if (!data) return null;
      const state = JSON.parse(data);
      state.completedSteps = state.completedSteps || {};
      return state;
   }

   // --- Public API ---

   public async getProjects(): Promise<DeploymentProject[]> {
      return this.projectRepo.find({ order: { id: "ASC" } });
   }

   public async getProject(slug: string): Promise<DeploymentProject | null> {
      return this.projectRepo.findOneBy({ slug });
   }

   public async saveProject(project: DeploymentProject): Promise<DeploymentProject> {
      return this.projectRepo.save(project);
   }

   public async deleteProject(slug: string): Promise<void> {
      await this.projectRepo.delete({ slug });
   }

   public async isRunning(): Promise<boolean> {
      const current = await this.getState(REDIS_KEY_CURRENT);
      return current?.status === "running";
   }

   public async getSteps(projectSlug: string): Promise<{ step: string; name: string; skip?: boolean }[]> {
      const project = await this.projectRepo.findOneBy({ slug: projectSlug });
      if (!project) return [];
      return project.getSteps().map(s => ({ step: s.step, name: s.name, skip: s.skip }));
   }

   public async getCurrentDeployment(): Promise<DeploymentState | null> {
      return this.getState(REDIS_KEY_CURRENT);
   }

   public async getLastDeployment(): Promise<DeploymentState | null> {
      return this.getState(REDIS_KEY_LAST);
   }

   public getSubject(): Subject<MessageEvent> | null {
      return this.deploymentSubject;
   }

   public async cancelDeployment(): Promise<void> {
      const current = await this.getState(REDIS_KEY_CURRENT);
      if (!current || current.status !== "running") {
         throw new Error("No deployment in progress");
      }
      this.cancelled = true;
      if (this.currentProcess) {
         this.currentProcess.kill("SIGTERM");
         this.currentProcess = null;
      }
      const runningStep = current.currentStep;
      if (runningStep) {
         runningStep.status = "failed";
         runningStep.error = "Cancelled by user";
         runningStep.finishedAt = new Date();
      }
      current.status = "failed";
      current.finishedAt = new Date();
      await this.saveState(current, REDIS_KEY_CURRENT);
      await this.saveState(current, REDIS_KEY_LAST);
      this.emit({ type: "deployment_complete", deployment: current });
      this.deploymentSubject?.complete();
      this.logger.log("Deployment cancelled by user");
   }

   public async retryStep(step: string): Promise<Subject<MessageEvent>> {
      if (await this.isRunning()) {
         throw new Error("Deployment already in progress");
      }
      const current = await this.getState(REDIS_KEY_CURRENT);
      if (!current || current.status !== "failed") {
         throw new Error("No failed deployment to retry");
      }
      const stepState = current.currentStep;
      if (!stepState || stepState.status !== "failed") {
         throw new Error("Step not found or not failed");
      }

      current.currentStep = { status: "pending", output: "", error: undefined, startedAt: undefined, finishedAt: undefined, step };
      current.status = "running";
      current.finishedAt = undefined;
      await this.saveState(current, REDIS_KEY_CURRENT);

      this.deploymentSubject = new Subject<MessageEvent>();
      this.cancelled = false;

      const project = await this.projectRepo.findOneBy({ slug: current.project });
      if (!project) throw new Error(`Project ${current.project} not found`);

      const stepsToRun = this.getFollowingSteps(current.currentStep, project.getSteps());
      this.runSteps(stepsToRun, this.resolveWorkDir(project), current.project, current);
      return this.deploymentSubject;
   }

   public async startDeployment(projectSlug: string, triggeredBy: string): Promise<Subject<MessageEvent>> {
      if (await this.isRunning()) {
         throw new Error("Deployment already in progress");
      }

      const project = await this.projectRepo.findOneBy({ slug: projectSlug });
      if (!project) throw new Error(`Project "${projectSlug}" not found`);
      if (!project.enabled) throw new Error(`Project "${projectSlug}" is disabled`);

      const steps = project.getSteps();
      const workDir = this.resolveWorkDir(project);
      if (!workDir) {
         throw new Error(`Working directory not configured for project "${projectSlug}"`);
      }

      this.deploymentSubject = new Subject<MessageEvent>();
      this.cancelled = false;
      const deployment: DeploymentState = {
         id: `deploy_${Date.now()}`,
         project: projectSlug,
         status: "running",
         currentStep: {
            step: steps[0].step,
            status: "pending",
            output: "",
            startedAt: undefined,
            finishedAt: undefined,
            error: "",
            attempt: 1,
            maxAttempts: 3,
         },
         completedSteps: {},
         startedAt: new Date(),
         triggeredBy,
      };
      await this.saveState(deployment, REDIS_KEY_CURRENT);

      this.runDeployment(steps, workDir, projectSlug, deployment);

      return this.deploymentSubject;
   }

   // --- Internal ---

   private getFollowingSteps(step: StepState, allSteps: DeploymentStepConfig[]) {
      const idx = allSteps.findIndex(s => s.step === step.step);
      // If the current step already succeeded (e.g. restart), start from the next one
      if (step.status === "success" && idx >= 0) {
         return allSteps.slice(idx + 1);
      }
      return allSteps.slice(idx);
   }

   private async runSteps(
      steps: DeploymentStepConfig[],
      workDir: string,
      projectSlug: string,
      deployment: DeploymentState,
   ) {
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;

      for (const stepConfig of steps) {
         if (this.cancelled) return;

         const stepState = deployment.currentStep;
         stepState.step = stepConfig.step;
         stepState.output = "";
         stepState.error = undefined;

         if (stepConfig.skip) {
            stepState.status = "skipped";
            stepState.output = "Skipped (permanently disabled)\n";
            deployment.completedSteps[stepConfig.step] = { ...stepState };
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_complete", step: stepConfig.step, status: "skipped" });
            continue;
         }

         // Handle restart step — triggers process restart, remaining steps resume on init
         if (stepConfig.triggersRestart) {
            stepState.status = "running";
            stepState.startedAt = new Date();
            stepState.output = `Initiating restart via: ${stepConfig.cmd} ${stepConfig.args.join(" ")}...\n`;
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_start", step: stepConfig.step, startedAt: stepState.startedAt });
            this.emit({ type: "step_output", step: stepConfig.step, output: stepState.output });

            stepState.status = "success";
            stepState.finishedAt = new Date();
            stepState.output += "Restart command sent. Remaining steps will run after restart.\n";
            deployment.completedSteps[stepConfig.step] = { ...stepState };
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_output", step: stepConfig.step, output: "Restart command sent. Remaining steps will run after restart.\n" });
            this.emit({ type: "step_complete", step: stepConfig.step, status: "success", finishedAt: stepState.finishedAt });

            const proc = spawn(stepConfig.cmd, stepConfig.args, { detached: true, stdio: "ignore", shell: true });
            if (proc.unref) proc.unref();
            return;
         }

         const maxAttempts = 3;
         stepState.attempt = 1;
         stepState.maxAttempts = maxAttempts;

         while (stepState.attempt <= maxAttempts && !this.cancelled) {
            stepState.status = "running";
            stepState.startedAt = new Date();
            stepState.error = undefined;
            if (stepState.attempt > 1) {
               stepState.output += `\n--- Retry attempt ${stepState.attempt}/${maxAttempts} ---\n`;
               this.emit({ type: "step_output", step: stepConfig.step, output: `\n--- Retry attempt ${stepState.attempt}/${maxAttempts} ---\n` });
            }
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_start", step: stepConfig.step, startedAt: stepState.startedAt, attempt: stepState.attempt, maxAttempts });

            try {
               await this.runStep(stepConfig.cmd, stepConfig.args, workDir, stepConfig.step, deployment);
               stepState.status = "success";
               stepState.finishedAt = new Date();
               deployment.completedSteps[stepConfig.step] = { ...stepState };
               await this.saveState(deployment, REDIS_KEY_CURRENT);
               this.emit({ type: "step_complete", step: stepConfig.step, status: "success", finishedAt: stepState.finishedAt });
               break;
            } catch (error) {
               stepState.error = (error as Error).message;
               if (stepState.attempt < maxAttempts) {
                  stepState.output += `\nAttempt ${stepState.attempt} failed: ${stepState.error}\n`;
                  this.emit({ type: "step_output", step: stepConfig.step, output: `\nAttempt ${stepState.attempt} failed: ${stepState.error}\n` });
                  stepState.attempt++;
                  await new Promise(r => setTimeout(r, 2000));
               } else {
                  stepState.status = "failed";
                  stepState.finishedAt = new Date();
                  deployment.completedSteps[stepConfig.step] = { ...stepState };
                  this.emit({ type: "step_complete", step: stepConfig.step, status: "failed", error: stepState.error, finishedAt: stepState.finishedAt });
                  break;
               }
            }
         }

         if (stepState.status === "failed") {
            deployment.status = "failed";
            deployment.finishedAt = new Date();
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            await this.saveState(deployment, REDIS_KEY_LAST);
            this.emit({ type: "deployment_complete", deployment });
            this.deploymentSubject?.complete();
            this.logger.error(`Deployment failed at ${stepConfig.step}: ${stepState.error}`);
            this.emailService.sendEmail({
               subject: `Shado Cloud - ${projectSlug} deployment FAILED`,
               html: this.buildEmailHtml({
                  title: "Deployment Failed",
                  status: "failed",
                  project: projectSlug,
                  triggeredBy: deployment.triggeredBy,
                  failedStep: stepConfig.name,
                  error: stepState.error,
                  deployPageUrl,
               }),
            });
            return;
         }
      }

      deployment.status = "success";
      deployment.finishedAt = new Date();
      await this.saveState(deployment, REDIS_KEY_CURRENT);
      await this.saveState(deployment, REDIS_KEY_LAST);
      this.emit({ type: "deployment_complete", deployment });
      this.deploymentSubject?.complete();
      this.logger.log(`Deployment completed successfully`);

      const duration = Math.round((new Date(deployment.finishedAt).getTime() - new Date(deployment.startedAt).getTime()) / 1000);
      this.emailService.sendEmail({
         subject: `Shado Cloud - ${projectSlug} deployment SUCCESS`,
         html: this.buildEmailHtml({
            title: "Deployment Successful",
            status: "success",
            project: projectSlug,
            triggeredBy: deployment.triggeredBy,
            duration: `${duration}s`,
            deployPageUrl,
         }),
      });
   }

   private async runDeployment(
      steps: DeploymentStepConfig[],
      workDir: string,
      projectSlug: string,
      deployment: DeploymentState,
   ) {
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;

      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, "enable_pipeline_deployment")) {
         this.logger.warn("Deployment blocked: enable_pipeline_deployment feature flag is disabled");
         deployment.status = "failed";
         deployment.currentStep.status = "failed";
         deployment.currentStep.error = "Deployments are disabled (feature flag: enable_pipeline_deployment)";
         await this.saveState(deployment, REDIS_KEY_CURRENT);
         await this.saveState(deployment, REDIS_KEY_LAST);
         this.emit({ type: "deployment_complete", deployment });
         this.deploymentSubject?.complete();
         return;
      }

      this.emailService.sendEmail({
         subject: `Shado Cloud - ${projectSlug} deployment started`,
         html: this.buildEmailHtml({
            title: "Deployment Started",
            status: "running",
            project: projectSlug,
            triggeredBy: deployment.triggeredBy,
            deployPageUrl,
         }),
      });

      await this.runSteps(steps, workDir, projectSlug, deployment);
   }

   private runStep(cmd: string, args: string[], cwd: string, step: string, deployment: DeploymentState): Promise<void> {
      return new Promise((resolve, reject) => {
         const env = {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            PM2_NO_INTERACTION: "1",
            CI: "true",
         };
         const proc = spawn(cmd, args, { cwd, shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
         this.currentProcess = proc;
         const stepState = deployment.currentStep;

         const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

         proc.stdout.on("data", (data) => {
            const output = stripAnsi(data.toString());
            stepState.output += output;
            this.emit({ type: "step_output", step, output });
         });

         proc.stderr.on("data", (data) => {
            const output = stripAnsi(data.toString());
            stepState.output += output;
            this.emit({ type: "step_output", step, output });
         });

         proc.on("close", (code) => {
            this.currentProcess = null;
            if (code === 0 || code === null) resolve();
            else reject(new Error(`Process exited with code ${code}`));
         });

         proc.on("error", (err) => {
            this.currentProcess = null;
            reject(err);
         });
      });
   }

   private emit(event: DeploymentEvent) {
      if (this.deploymentSubject) {
         this.deploymentSubject.next({ data: JSON.stringify(event) } as MessageEvent);
      }
   }

   private buildEmailHtml(opts: {
      title: string;
      status: "running" | "success" | "failed";
      project: string;
      triggeredBy: string;
      deployPageUrl: string;
      failedStep?: string;
      error?: string;
      duration?: string;
   }): string {
      const statusColors = {
         running: { bg: "#3b82f6", text: "In Progress" },
         success: { bg: "#22c55e", text: "Success" },
         failed: { bg: "#ef4444", text: "Failed" },
      };
      const status = statusColors[opts.status];

      return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f7; padding: 40px 20px; margin: 0;">
   <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
      <div style="background: ${status.bg}; padding: 24px; text-align: center;">
         <h1 style="color: white; margin: 0; font-size: 24px;">${opts.title}</h1>
      </div>
      <div style="padding: 24px;">
         <table style="width: 100%; border-collapse: collapse;">
            <tr>
               <td style="padding: 8px 0; color: #666;">Project</td>
               <td style="padding: 8px 0; text-align: right; font-weight: 600;">${opts.project}</td>
            </tr>
            <tr>
               <td style="padding: 8px 0; color: #666;">Status</td>
               <td style="padding: 8px 0; text-align: right;">
                  <span style="background: ${status.bg}; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px;">${status.text}</span>
               </td>
            </tr>
            <tr>
               <td style="padding: 8px 0; color: #666;">Triggered by</td>
               <td style="padding: 8px 0; text-align: right;">${opts.triggeredBy}</td>
            </tr>
            ${opts.duration ? `<tr><td style="padding: 8px 0; color: #666;">Duration</td><td style="padding: 8px 0; text-align: right;">${opts.duration}</td></tr>` : ""}
            ${opts.failedStep ? `<tr><td style="padding: 8px 0; color: #666;">Failed at</td><td style="padding: 8px 0; text-align: right; color: #ef4444;">${opts.failedStep}</td></tr>` : ""}
         </table>
         ${opts.error ? `<div style="margin-top: 16px; padding: 12px; background: #fef2f2; border-radius: 8px; font-family: monospace; font-size: 12px; color: #991b1b; word-break: break-all;">${opts.error}</div>` : ""}
         <a href="${opts.deployPageUrl}" style="display: block; margin-top: 24px; padding: 12px; background: #1f2937; color: white; text-align: center; text-decoration: none; border-radius: 8px; font-weight: 500;">View Deployment</a>
      </div>
   </div>
</body>
</html>`;
   }
}
