import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "child_process";

export interface RunCommandOptions {
   cmd: string;
   args: string[];
   cwd: string;
   /** 0 = no timeout. */
   timeoutMs?: number;
   /** Receives ANSI-stripped stdout/stderr chunks as they arrive. */
   onOutput: (chunk: string) => void;
}

export interface RunCommandResult {
   exitCode: number | null;
}

const ANSI_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(value: string): string {
   return value.replace(ANSI_PATTERN, "");
}

/**
 * Executes pipeline target / workflow step commands.
 *
 * Extracted from the original deployment service so the pipeline engine, the
 * approval-workflow engine and the legacy deployment path all share one
 * definition of "run a command and stream its output".
 *
 * The child process gets a deliberately minimal environment: inheriting the
 * whole API process env would leak database and service credentials into
 * arbitrary admin-configured commands.
 */
@Injectable()
export class StepRunnerService {
   private readonly logger = new Logger(StepRunnerService.name);

   /** Processes currently running, keyed by an opaque handle so callers can cancel. */
   private readonly running = new Map<string, ReturnType<typeof spawn>>();

   private childEnv(): NodeJS.ProcessEnv {
      return {
         PATH: process.env.PATH,
         HOME: process.env.HOME,
         SHELL: process.env.SHELL,
         LANG: process.env.LANG,
         FORCE_COLOR: "0",
         NO_COLOR: "1",
         PM2_NO_INTERACTION: "1",
         CI: "true",
      };
   }

   /** Resolves the `__CWD__` sentinel to the API process working directory. */
   public resolveWorkDir(...candidates: (string | null | undefined)[]): string {
      for (const candidate of candidates) {
         if (!candidate) continue;
         if (candidate === "__CWD__") return process.cwd();
         return candidate;
      }
      return process.cwd();
   }

   /**
    * Runs a command to completion.
    *
    * Resolves when the process exits 0. Rejects on a non-zero exit, a spawn
    * error, or the timeout elapsing. Unlike the previous implementation a `null`
    * exit code (killed by signal) is treated as a *failure* rather than a
    * success — the only legitimate signal kill is our own cancel/timeout path,
    * which surfaces its own error.
    */
   public async run(handle: string, options: RunCommandOptions): Promise<RunCommandResult> {
      const { cmd, args, cwd, timeoutMs = 0, onOutput } = options;

      onOutput(`[cwd: ${cwd}] $ ${cmd} ${args.join(" ")}\n`);

      return new Promise<RunCommandResult>((resolve, reject) => {
         let settled = false;
         let timer: NodeJS.Timeout | null = null;
         let timedOut = false;

         const proc = spawn(cmd, args, {
            cwd,
            shell: true,
            env: this.childEnv(),
            stdio: ["ignore", "pipe", "pipe"],
         });
         this.running.set(handle, proc);

         const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            this.running.delete(handle);
            fn();
         };

         if (timeoutMs > 0) {
            timer = setTimeout(() => {
               timedOut = true;
               proc.kill("SIGTERM");
               // Escalate if the process ignores SIGTERM.
               setTimeout(() => proc.kill("SIGKILL"), 5_000).unref?.();
            }, timeoutMs);
         }

         proc.stdout?.on("data", (data: Buffer) => onOutput(stripAnsi(data.toString())));
         proc.stderr?.on("data", (data: Buffer) => onOutput(stripAnsi(data.toString())));

         proc.on("close", (code) => {
            finish(() => {
               if (timedOut) {
                  reject(new Error(`Timed out after ${timeoutMs}ms`));
               } else if (code === 0) {
                  resolve({ exitCode: code });
               } else if (code === null) {
                  reject(new Error("Process was terminated"));
               } else {
                  reject(new Error(`Process exited with code ${code}`));
               }
            });
         });

         proc.on("error", (err) => finish(() => reject(err)));
      });
   }

   /**
    * Fires a command that will restart this process. Detached + unref'd so it
    * survives our own death.
    */
   public spawnDetached(cmd: string, args: string[], cwd: string): void {
      const proc = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", shell: true });
      proc.unref?.();
      this.logger.log(`Fired detached restart command: ${cmd} ${args.join(" ")}`);
   }

   /**
    * Runs a command and returns its trimmed stdout, ignoring failures.
    *
    * Used for cheap introspection (`git log`, `git rev-parse`) where a missing
    * binary or a directory that is not a repository is an expected outcome, not
    * an error worth failing a run over.
    */
   public async capture(cmd: string, args: string[], cwd: string, timeoutMs = 5_000): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
         let settled = false;
         let stdout = "";

         const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
         };

         let proc: ReturnType<typeof spawn>;
         try {
            proc = spawn(cmd, args, {
               cwd,
               shell: true,
               env: this.childEnv(),
               stdio: ["ignore", "pipe", "ignore"],
            });
         } catch {
            return finish(null);
         }

         const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            finish(null);
         }, timeoutMs);

         proc.stdout?.on("data", (data: Buffer) => {
            stdout += data.toString();
         });
         proc.on("error", () => finish(null));
         proc.on("close", (code) => finish(code === 0 ? stripAnsi(stdout).trim() : null));
      });
   }

   /** Kills the process registered under `handle`, if any. Returns true if one was killed. */
   public cancel(handle: string): boolean {
      const proc = this.running.get(handle);
      if (!proc) return false;
      proc.kill("SIGTERM");
      this.running.delete(handle);
      return true;
   }

   /** Kills every tracked process. Used when a whole run is cancelled. */
   public cancelAll(prefix?: string): number {
      let killed = 0;
      for (const [handle, proc] of this.running.entries()) {
         if (prefix && !handle.startsWith(prefix)) continue;
         proc.kill("SIGTERM");
         this.running.delete(handle);
         killed++;
      }
      return killed;
   }
}
