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
import * as fs from "fs";
import * as path from "path";

export type DeploymentStep = "git_pull" | "npm_install" | "test" | "build" | "migrate" | "restart" | "verify";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface StepState {
   step: DeploymentStep;
   status: StepStatus;
   output: string;
   startedAt?: Date;
   finishedAt?: Date;
   error?: string;
}

export interface DeploymentState {
   id: string;
   project: "backend" | "frontend";
   status: "running" | "success" | "failed";
   steps: StepState[];
   startedAt: Date;
   finishedAt?: Date;
   triggeredBy: string;
}

interface DeploymentEvent {
   type: "step_start" | "step_output" | "step_complete" | "deployment_complete";
   step?: DeploymentStep;
   output?: string;
   status?: StepStatus;
   error?: string;
   startedAt?: Date;
   finishedAt?: Date;
   deployment?: DeploymentState;
}

const REDIS_KEY_CURRENT = "deployment:current";
const REDIS_KEY_LAST = "deployment:last";

@Injectable()
export class DeploymentService implements OnModuleInit {
   private deploymentSubject: Subject<MessageEvent> | null = null;
   private currentProcess: ReturnType<typeof spawn> | null = null;

   private readonly backendSteps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[] = [
      { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
      { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
      { step: "test", name: "Run Tests", cmd: "npm", args: ["test", "--", "--runInBand", "--no-colors"] },
      { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
      { step: "migrate", name: "Run Migrations", cmd: "npx", args: ["typeorm", "migration:run", "-d", "ormconfig.js"] },
      { step: "restart", name: "Restart Service", cmd: "", args: [] }, // handled specially
      { step: "verify", name: "Verify Deployment", cmd: "", args: [] }, // runs on startup
   ];

   private readonly frontendSteps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[] = [
      { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
      { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
      { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
   ];

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly logger: LoggerToDb,
      private readonly emailService: EmailService,
      private readonly featureFlagService: FeatureFlagService,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
   ) {}

   async onModuleInit() {
      // Check if we need to complete a verify step after restart
      const deployment = await this.getState(REDIS_KEY_CURRENT);
      if (deployment?.status === "running" && deployment.project === "backend") {
         const verifyStep = deployment.steps.find(s => s.step === "verify");
         const restartStep = deployment.steps.find(s => s.step === "restart");
         
         // If restart succeeded and verify is pending, run verification
         if (restartStep?.status === "success" && verifyStep?.status === "pending") {
            this.logger.log("Resuming deployment verification after restart...");
            await this.runVerifyStep(deployment);
         }
      }
   }

   private async runVerifyStep(deployment: DeploymentState) {
      const verifyStep = deployment.steps.find(s => s.step === "verify")!;
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;
      
      verifyStep.status = "running";
      verifyStep.startedAt = new Date();
      verifyStep.output = "Verifying deployment after restart...\n";
      await this.saveState(deployment, REDIS_KEY_CURRENT);

      try {
         // Check PM2 process is running
         const pid = await this.getPm2Pid("shado-cloud-backend");
         if (!pid) throw new Error("PM2 process not running");
         verifyStep.output += `PM2 process running with PID: ${pid}\n`;

         // Verify .env was loaded (check a known env var)
         const envCheck = process.env.NODE_ENV ? "OK" : "MISSING";
         verifyStep.output += `Environment loaded: ${envCheck}\n`;

         verifyStep.status = "success";
         verifyStep.finishedAt = new Date();
         deployment.status = "success";
         deployment.finishedAt = new Date();
         await this.saveState(deployment, REDIS_KEY_CURRENT);
         await this.saveState(deployment, REDIS_KEY_LAST);

         const duration = Math.round((new Date(deployment.finishedAt).getTime() - new Date(deployment.startedAt).getTime()) / 1000);
         this.logger.log(`Deployment verified successfully`);
         this.emailService.sendEmail({
            subject: `Shado Cloud - ${deployment.project} deployment SUCCESS`,
            html: this.buildEmailHtml({
               title: "Deployment Successful",
               status: "success",
               project: deployment.project,
               triggeredBy: deployment.triggeredBy,
               deployPageUrl,
               duration: `${Math.floor(duration / 60)}m ${duration % 60}s`,
            }),
         });
      } catch (error) {
         verifyStep.status = "failed";
         verifyStep.error = (error as Error).message;
         verifyStep.finishedAt = new Date();
         deployment.status = "failed";
         deployment.finishedAt = new Date();
         await this.saveState(deployment, REDIS_KEY_CURRENT);
         await this.saveState(deployment, REDIS_KEY_LAST);

         this.logger.error(`Deployment verification failed: ${verifyStep.error}`);
         this.emailService.sendEmail({
            subject: `Shado Cloud - ${deployment.project} deployment FAILED`,
            html: this.buildEmailHtml({
               title: "Deployment Failed",
               status: "failed",
               project: deployment.project,
               triggeredBy: deployment.triggeredBy,
               failedStep: "Verify Deployment",
               error: verifyStep.error,
               deployPageUrl,
            }),
         });
      }
   }

   private getPm2Pid(name: string): Promise<string | null> {
      return new Promise((resolve) => {
         const proc = spawn("pm2", ["jlist"], { shell: true, env: { ...process.env, PM2_HOME: process.env.HOME + "/.pm2" } });
         let output = "";
         let stderr = "";
         proc.stdout.on("data", (data) => output += data.toString());
         proc.stderr.on("data", (data) => stderr += data.toString());
         proc.on("close", (code) => {
            this.logger.log(`pm2 jlist exit code: ${code}, stdout length: ${output.length}, stderr: ${stderr.substring(0, 200)}`);
            try {
               const list = JSON.parse(output);
               const app = list.find((p: any) => p.name === name);
               this.logger.log(`Found app: ${app?.name}, pid: ${app?.pid}, status: ${app?.pm2_env?.status}`);
               resolve(app?.pid?.toString() || null);
            } catch (e) {
               this.logger.error(`Failed to parse pm2 jlist: ${(e as Error).message}, output: ${output.substring(0, 200)}`);
               resolve(null);
            }
         });
         proc.on("error", (e) => {
            this.logger.error(`pm2 jlist spawn error: ${e.message}`);
            resolve(null);
         });
      });
   }

   private async saveState(deployment: DeploymentState | null, key: string) {
      if (deployment) {
         await this.redis.set(key, JSON.stringify(deployment), "EX", 86400); // 24h TTL
      } else {
         await this.redis.del(key);
      }
   }

   private async getState(key: string): Promise<DeploymentState | null> {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
   }

   public async isRunning(): Promise<boolean> {
      const current = await this.getState(REDIS_KEY_CURRENT);
      return current?.status === "running";
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
      if (this.currentProcess) {
         this.currentProcess.kill("SIGTERM");
         this.currentProcess = null;
      }
      const runningStep = current.steps.find(s => s.status === "running");
      if (runningStep) {
         runningStep.status = "failed";
         runningStep.error = "Cancelled by user";
         runningStep.finishedAt = new Date();
      }
      for (const s of current.steps) {
         if (s.status === "pending") s.status = "skipped";
      }
      current.status = "failed";
      current.finishedAt = new Date();
      await this.saveState(current, REDIS_KEY_CURRENT);
      await this.saveState(current, REDIS_KEY_LAST);
      this.emit({ type: "deployment_complete", deployment: current });
      this.deploymentSubject?.complete();
      this.logger.log("Deployment cancelled by user");
   }

   public async retryStep(step: DeploymentStep): Promise<Subject<MessageEvent>> {
      if (await this.isRunning()) {
         throw new Error("Deployment already in progress");
      }
      const current = await this.getState(REDIS_KEY_CURRENT);
      if (!current || current.status !== "failed") {
         throw new Error("No failed deployment to retry");
      }
      const stepState = current.steps.find(s => s.step === step);
      if (!stepState || stepState.status !== "failed") {
         throw new Error("Step not found or not failed");
      }

      // Reset this step and all following steps
      let found = false;
      for (const s of current.steps) {
         if (s.step === step) found = true;
         if (found) {
            s.status = "pending";
            s.output = "";
            s.error = undefined;
            s.startedAt = undefined;
            s.finishedAt = undefined;
         }
      }

      current.status = "running";
      current.finishedAt = undefined;
      await this.saveState(current, REDIS_KEY_CURRENT);
      
      this.deploymentSubject = new Subject<MessageEvent>();

      const steps = current.project === "backend" ? this.backendSteps : this.frontendSteps;
      const workDir = current.project === "backend"
         ? process.cwd()
         : this.config.get("FRONTEND_DEPLOY_PATH")!;
      
      const stepsToRun = steps.filter(s => {
         const state = current.steps.find(st => st.step === s.step);
         return state?.status === "pending";
      });

      this.runSteps(stepsToRun, workDir, current.project, current);
      return this.deploymentSubject;
   }

   public async startDeployment(
      project: "backend" | "frontend",
      triggeredBy: string,
   ): Promise<Subject<MessageEvent>> {
      if (await this.isRunning()) {
         throw new Error("Deployment already in progress");
      }

      const steps = project === "backend" ? this.backendSteps : this.frontendSteps;
      const workDir = project === "backend" 
         ? process.cwd()
         : this.config.get("FRONTEND_DEPLOY_PATH");

      if (project === "frontend" && !workDir) {
         throw new Error("FRONTEND_DEPLOY_PATH not configured");
      }

      this.deploymentSubject = new Subject<MessageEvent>();
      const deployment: DeploymentState = {
         id: `deploy_${Date.now()}`,
         project,
         status: "running",
         steps: steps.map(s => ({ step: s.step, status: "pending" as StepStatus, output: "" })),
         startedAt: new Date(),
         triggeredBy,
      };
      await this.saveState(deployment, REDIS_KEY_CURRENT);

      this.runDeployment(steps, workDir!, project, deployment);

      return this.deploymentSubject;
   }

   private async runSteps(
      steps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[],
      workDir: string,
      project: "backend" | "frontend",
      deployment: DeploymentState,
   ) {
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;

      for (const stepConfig of steps) {
         const stepState = deployment.steps.find(s => s.step === stepConfig.step)!;
         
         // For backend restart: mark restart success, leave verify pending, then restart
         if (stepConfig.step === "restart" && project === "backend") {
            stepState.status = "running";
            stepState.startedAt = new Date();
            stepState.output = "Initiating PM2 restart...\n";
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_start", step: stepConfig.step, startedAt: stepState.startedAt });
            this.emit({ type: "step_output", step: stepConfig.step, output: stepState.output });
            
            // Mark restart as success (verify will run after app restarts)
            stepState.status = "success";
            stepState.finishedAt = new Date();
            stepState.output += "Restart command sent. Verification will run after restart.\n";
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_output", step: stepConfig.step, output: "Restart command sent. Verification will run after restart.\n" });
            this.emit({ type: "step_complete", step: stepConfig.step, status: "success", finishedAt: stepState.finishedAt });
            
            // Trigger restart (this will kill the process, verify runs on startup)
            const proc = spawn("pm2", ["restart", "shado-cloud-backend", "--update-env"], { detached: true, stdio: "ignore" });
            if (proc.unref) proc.unref();
            return;
         }

         // Skip verify step here - it runs on module init after restart
         if (stepConfig.step === "verify" && project === "backend") {
            continue;
         }
         
         stepState.status = "running";
         stepState.startedAt = new Date();
         await this.saveState(deployment, REDIS_KEY_CURRENT);
         this.emit({ type: "step_start", step: stepConfig.step, startedAt: stepState.startedAt });

         try {
            await this.runStep(stepConfig.cmd, stepConfig.args, workDir, stepConfig.step, deployment);
            stepState.status = "success";
            stepState.finishedAt = new Date();
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            this.emit({ type: "step_complete", step: stepConfig.step, status: "success", finishedAt: stepState.finishedAt });
         } catch (error) {
            stepState.status = "failed";
            stepState.error = (error as Error).message;
            stepState.finishedAt = new Date();
            this.emit({ type: "step_complete", step: stepConfig.step, status: "failed", error: stepState.error, finishedAt: stepState.finishedAt });
            
            for (const s of deployment.steps) {
               if (s.status === "pending") s.status = "skipped";
            }
            
            deployment.status = "failed";
            deployment.finishedAt = new Date();
            await this.saveState(deployment, REDIS_KEY_CURRENT);
            await this.saveState(deployment, REDIS_KEY_LAST);
            this.emit({ type: "deployment_complete", deployment });
            this.deploymentSubject?.complete();
            this.logger.error(`Deployment failed at ${stepConfig.step}: ${stepState.error}`);
            this.emailService.sendEmail({
               subject: `Shado Cloud - ${project} deployment FAILED`,
               html: this.buildEmailHtml({
                  title: "Deployment Failed",
                  status: "failed",
                  project,
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
         subject: `Shado Cloud - ${project} deployment SUCCESS`,
         html: this.buildEmailHtml({
            title: "Deployment Successful",
            status: "success",
            project,
            triggeredBy: deployment.triggeredBy,
            duration: `${duration}s`,
            deployPageUrl,
         }),
      });
   }

   private async runDeployment(
      steps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[],
      workDir: string,
      project: "backend" | "frontend",
      deployment: DeploymentState,
   ) {
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;

      // Check feature flag
      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, `auto_${project}_redeploy`)) {
         this.logger.warn(`Deployment blocked: auto_${project}_redeploy feature flag is disabled`);
         deployment.status = "failed";
         deployment.steps[0].status = "failed";
         deployment.steps[0].error = "Feature flag disabled";
         await this.saveState(deployment, REDIS_KEY_CURRENT);
         await this.saveState(deployment, REDIS_KEY_LAST);
         this.emit({ type: "deployment_complete", deployment });
         this.deploymentSubject?.complete();
         return;
      }

      // Send start email
      this.emailService.sendEmail({
         subject: `Shado Cloud - ${project} deployment started`,
         html: this.buildEmailHtml({
            title: "Deployment Started",
            status: "running",
            project,
            triggeredBy: deployment.triggeredBy,
            deployPageUrl,
         }),
      });

      await this.runSteps(steps, workDir, project, deployment);
   }

   private runStep(cmd: string, args: string[], cwd: string, step: DeploymentStep, deployment: DeploymentState): Promise<void> {
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
         const stepState = deployment.steps.find(s => s.step === step)!;

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
            if (code === 0 || code === null) {
               resolve();
            } else {
               reject(new Error(`Process exited with code ${code}`));
            }
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
