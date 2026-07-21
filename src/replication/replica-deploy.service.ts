import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "child_process";
import * as path from "path";
import { EnvVariables } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import { CONFIG_FILE_NAME } from "src/config/config.loader";
import {
   type DeployRequest,
   type DeployStep,
   type ReadConfigReply,
   type WriteConfigReply,
} from "./replica-link.constants";

/** Callbacks the client wires to socket emits so progress streams back to the master. */
export interface ReplicaDeployEmitter {
   output(step: string, output: string): void;
   step(step: string, name: string, status: "running" | "success" | "failed" | "skipped", error?: string): void;
   complete(status: "success" | "failed", error?: string): void;
}

/**
 * Replica-side deploy executor. Deliberately self-contained: on a replica node only the
 * ReplicationModule is booted (no DeploymentService / TypeORM / admin providers), so this
 * runs the master-sent commands with a minimal spawn loop and streams console output back
 * over the replica-link socket. It also reads/writes the replica's own .env / config.yml so
 * the master can view/edit them remotely.
 *
 * Commands always run in the replica's own working directory (process.cwd()); the master
 * only supplies the command + args, never a path.
 */
@Injectable()
export class ReplicaDeployService {
   private readonly logger = new Logger(ReplicaDeployService.name);
   private running = false;

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      @Inject() private readonly fs: AbstractFileSystem,
   ) {}

   private static readonly ANSI = /\x1B\[[0-9;]*[a-zA-Z]/g;

   /** Run the master-sent deploy, streaming output/step/complete via `emit`. */
   async runDeploy(request: DeployRequest, emit: ReplicaDeployEmitter): Promise<void> {
      if (this.running) {
         this.logger.warn(`Ignoring deploy ${request.deployId}: a replica deploy is already running`);
         emit.complete("failed", "A deploy is already running on this replica");
         return;
      }
      this.running = true;
      const cwd = process.cwd();
      this.logger.log(
         `Replica deploy ${request.deployId} for "${request.project}" — ${request.steps.length} step(s) in ${cwd}`,
      );

      try {
         for (const step of request.steps) {
            emit.step(step.step, step.name, "running");
            const header = `[cwd: ${cwd}] $ ${step.cmd} ${step.args.join(" ")}\n`;
            emit.output(step.step, header);

            // A restart step kills this process, so report success + finish FIRST, then
            // dispatch it detached (mirrors the master's own restart handling).
            if (step.triggersRestart) {
               emit.output(step.step, "Restart command dispatched; replica will restart.\n");
               emit.step(step.step, step.name, "success");
               emit.complete("success");
               const proc = spawn(step.cmd, step.args, { cwd, detached: true, stdio: "ignore", shell: true });
               if (proc.unref) proc.unref();
               return;
            }

            try {
               await this.runStep(step, cwd, (chunk) => emit.output(step.step, chunk));
               emit.step(step.step, step.name, "success");
            } catch (e) {
               const error = (e as Error).message;
               emit.output(step.step, `\n${error}\n`);
               emit.step(step.step, step.name, "failed", error);
               emit.complete("failed", error);
               this.logger.error(`Replica deploy ${request.deployId} failed at ${step.step}: ${error}`);
               return;
            }
         }
         emit.complete("success");
         this.logger.log(`Replica deploy ${request.deployId} completed successfully`);
      } finally {
         this.running = false;
      }
   }

   private runStep(step: DeployStep, cwd: string, onOutput: (chunk: string) => void): Promise<void> {
      const env = {
         PATH: process.env.PATH,
         HOME: process.env.HOME,
         SHELL: process.env.SHELL,
         FORCE_COLOR: "0",
         NO_COLOR: "1",
         PM2_NO_INTERACTION: "1",
         CI: "true",
      };
      return new Promise<void>((resolve, reject) => {
         const proc = spawn(step.cmd, step.args, { cwd, shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
         const pipe = (data: Buffer) => onOutput(data.toString().replace(ReplicaDeployService.ANSI, ""));
         proc.stdout.on("data", pipe);
         proc.stderr.on("data", pipe);
         proc.on("close", (code) => (code === 0 || code === null ? resolve() : reject(new Error(`Process exited with code ${code}`))));
         proc.on("error", (err) => reject(err));
      });
   }

   // ─────────────────────────── Local config file ───────────────────────────

   /** Resolve the replica's own config file: .env first, else config.yml. */
   private resolveConfigPath(): { path: string; filename: string } | null {
      const cwd = process.cwd();
      const envPath = path.join(cwd, ".env");
      if (this.fs.existsSync(envPath)) return { path: envPath, filename: ".env" };
      const ymlPath = path.join(cwd, CONFIG_FILE_NAME);
      if (this.fs.existsSync(ymlPath)) return { path: ymlPath, filename: CONFIG_FILE_NAME };
      return null;
   }

   readLocalConfig(): ReadConfigReply {
      try {
         const resolved = this.resolveConfigPath();
         if (!resolved) return { found: false, filename: null, content: "" };
         const content = this.fs.readFileSync(resolved.path, "utf-8") as string;
         return { found: true, filename: resolved.filename, content };
      } catch (e) {
         this.logger.error(`Failed to read local config: ${(e as Error).message}`);
         return { found: false, filename: null, content: "" };
      }
   }

   writeLocalConfig(content: string): WriteConfigReply {
      try {
         // Write to whichever file exists; if neither exists yet, default to config.yml.
         const resolved = this.resolveConfigPath();
         const target = resolved ?? { path: path.join(process.cwd(), CONFIG_FILE_NAME), filename: CONFIG_FILE_NAME };
         this.fs.writeFileSync(target.path, content, "utf-8");
         this.logger.log(`Local config updated (${target.filename}) by master`);
         return { success: true, filename: target.filename };
      } catch (e) {
         const message = (e as Error).message;
         this.logger.error(`Failed to write local config: ${message}`);
         return { success: false, filename: null, message };
      }
   }
}
