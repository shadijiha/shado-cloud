import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "child_process";
import { Subject } from "rxjs";
import { LoggerToDb } from "src/logging";
import { EnvVariables } from "src/config/config.validator";
import { EmailService } from "./email.service";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlagNamespace } from "src/models/admin/featureFlag";

export type DeploymentStep = "git_pull" | "npm_install" | "test" | "build" | "migrate" | "restart";
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

@Injectable()
export class DeploymentService {
   private currentDeployment: DeploymentState | null = null;
   private lastDeployment: DeploymentState | null = null;
   private deploymentSubject: Subject<MessageEvent> | null = null;

   private readonly backendSteps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[] = [
      { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
      { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
      { step: "test", name: "Run Tests", cmd: "npm", args: ["test", "--", "--runInBand"] },
      { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
      { step: "migrate", name: "Run Migrations", cmd: "npm", args: ["run", "typeorm:migrate", "--", "-d", "ormconfig.js"] },
      { step: "restart", name: "Restart Service", cmd: "pm2", args: ["reload", "shado-cloud-backend", "--update-env"] },
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
   ) {}

   public isRunning(): boolean {
      return this.currentDeployment?.status === "running";
   }

   public getCurrentDeployment(): DeploymentState | null {
      return this.currentDeployment;
   }

   public getLastDeployment(): DeploymentState | null {
      return this.lastDeployment;
   }

   public getSubject(): Subject<MessageEvent> | null {
      return this.deploymentSubject;
   }

   public startDeployment(
      project: "backend" | "frontend",
      triggeredBy: string,
   ): Subject<MessageEvent> {
      if (this.isRunning()) {
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
      this.currentDeployment = {
         id: `deploy_${Date.now()}`,
         project,
         status: "running",
         steps: steps.map(s => ({ step: s.step, status: "pending" as StepStatus, output: "" })),
         startedAt: new Date(),
         triggeredBy,
      };

      this.runDeployment(steps, workDir!, project);

      return this.deploymentSubject;
   }

   private async runDeployment(
      steps: { step: DeploymentStep; name: string; cmd: string; args: string[] }[],
      workDir: string,
      project: "backend" | "frontend",
   ) {
      const frontendUrl = this.config.get("FRONTEND_URL") || "";
      const deployPageUrl = `${frontendUrl}/admin/deploy`;

      // Check feature flag
      if (await this.featureFlagService.isFeatureFlagDisabled(FeatureFlagNamespace.Admin, `auto_${project}_redeploy`)) {
         this.logger.warn(`Deployment blocked: auto_${project}_redeploy feature flag is disabled`);
         this.currentDeployment!.status = "failed";
         this.currentDeployment!.steps[0].status = "failed";
         this.currentDeployment!.steps[0].error = "Feature flag disabled";
         this.lastDeployment = this.currentDeployment;
         this.emit({ type: "deployment_complete", deployment: this.currentDeployment! });
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
            triggeredBy: this.currentDeployment!.triggeredBy,
            deployPageUrl,
         }),
      });

      for (const stepConfig of steps) {
         const stepState = this.currentDeployment!.steps.find(s => s.step === stepConfig.step)!;
         
         stepState.status = "running";
         stepState.startedAt = new Date();
         this.emit({ type: "step_start", step: stepConfig.step, startedAt: stepState.startedAt });

         try {
            await this.runStep(stepConfig.cmd, stepConfig.args, workDir, stepConfig.step);
            stepState.status = "success";
            stepState.finishedAt = new Date();
            this.emit({ type: "step_complete", step: stepConfig.step, status: "success", finishedAt: stepState.finishedAt });
         } catch (error) {
            stepState.status = "failed";
            stepState.error = (error as Error).message;
            stepState.finishedAt = new Date();
            this.emit({ type: "step_complete", step: stepConfig.step, status: "failed", error: stepState.error, finishedAt: stepState.finishedAt });
            
            for (const s of this.currentDeployment!.steps) {
               if (s.status === "pending") s.status = "skipped";
            }
            
            this.currentDeployment!.status = "failed";
            this.currentDeployment!.finishedAt = new Date();
            this.lastDeployment = this.currentDeployment;
            this.emit({ type: "deployment_complete", deployment: this.currentDeployment! });
            this.deploymentSubject?.complete();
            this.logger.error(`Deployment failed at ${stepConfig.step}: ${stepState.error}`);
            this.emailService.sendEmail({
               subject: `Shado Cloud - ${project} deployment FAILED`,
               html: this.buildEmailHtml({
                  title: "Deployment Failed",
                  status: "failed",
                  project,
                  triggeredBy: this.currentDeployment!.triggeredBy,
                  failedStep: stepConfig.name,
                  error: stepState.error,
                  deployPageUrl,
               }),
            });
            return;
         }
      }

      this.currentDeployment!.status = "success";
      this.currentDeployment!.finishedAt = new Date();
      this.lastDeployment = this.currentDeployment;
      this.emit({ type: "deployment_complete", deployment: this.currentDeployment! });
      this.deploymentSubject?.complete();
      this.logger.log(`Deployment completed successfully`);
      
      const duration = Math.round((this.currentDeployment!.finishedAt.getTime() - this.currentDeployment!.startedAt.getTime()) / 1000);
      this.emailService.sendEmail({
         subject: `Shado Cloud - ${project} deployment SUCCESS`,
         html: this.buildEmailHtml({
            title: "Deployment Successful",
            status: "success",
            project,
            triggeredBy: this.currentDeployment!.triggeredBy,
            duration: `${duration}s`,
            deployPageUrl,
         }),
      });
   }

   private runStep(cmd: string, args: string[], cwd: string, step: DeploymentStep): Promise<void> {
      return new Promise((resolve, reject) => {
         const proc = spawn(cmd, args, { cwd, shell: true });
         const stepState = this.currentDeployment!.steps.find(s => s.step === step)!;

         proc.stdout.on("data", (data) => {
            const output = data.toString();
            stepState.output += output;
            this.emit({ type: "step_output", step, output });
         });

         proc.stderr.on("data", (data) => {
            const output = data.toString();
            stepState.output += output;
            this.emit({ type: "step_output", step, output });
         });

         proc.on("close", (code) => {
            if (code === 0) {
               resolve();
            } else {
               reject(new Error(`Process exited with code ${code}`));
            }
         });

         proc.on("error", (err) => {
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
