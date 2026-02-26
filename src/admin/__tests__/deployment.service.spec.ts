import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DeploymentService } from "../deployment.service";
import { LoggerToDb } from "../../logging";
import { EmailService } from "../email.service";
import { FeatureFlagService } from "../feature-flag.service";
import { REDIS_CACHE } from "../../util";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DeploymentProject } from "../../models/admin/deploymentProject";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

jest.mock("child_process");

const backendSteps = [
   { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
   { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
   { step: "test", name: "Run Tests", cmd: "npm", args: ["test", "--", "--runInBand", "--no-colors"] },
   { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
   { step: "migrate", name: "Run Migrations", cmd: "npx", args: ["typeorm", "migration:run", "-d", "ormconfig.js"] },
   { step: "restart", name: "Restart Service", cmd: "pm2", args: ["restart", "shado-cloud-backend"], triggersRestart: true },
   { step: "verify", name: "Verify Deployment", cmd: "pm2", args: ["jlist"], runsOnModuleInit: true },
];

function makeProject(slug: string, steps: any[], workDir = "__CWD__"): DeploymentProject {
   const p = new DeploymentProject();
   p.id = 1;
   p.slug = slug;
   p.name = slug;
   p.workDir = workDir;
   p.pm2ProcessName = null;
   p.branch = "master";
   p.enabled = true;
   p.setSteps(steps);
   return p;
}

describe("DeploymentService", () => {
   let service: DeploymentService;
   let emailService: EmailService;
   let featureFlagService: FeatureFlagService;
   let logger: LoggerToDb;
   const redisStore: Record<string, string> = {};
   let projectRepo: any;

   beforeEach(async () => {
      Object.keys(redisStore).forEach(k => delete redisStore[k]);

      projectRepo = {
         find: jest.fn().mockResolvedValue([makeProject("backend", backendSteps)]),
         findOneBy: jest.fn().mockImplementation(({ slug }: any) => {
            if (slug === "backend") return Promise.resolve(makeProject("backend", backendSteps));
            if (slug === "frontend") return Promise.resolve(makeProject("frontend", [
               { step: "git_pull", name: "Git Pull", cmd: "git", args: ["pull"] },
               { step: "npm_install", name: "NPM Install", cmd: "npm", args: ["install"] },
               { step: "build", name: "Build", cmd: "npm", args: ["run", "build"] },
            ], "/tmp/frontend"));
            return Promise.resolve(null);
         }),
         create: jest.fn((data: any) => data),
         save: jest.fn().mockResolvedValue({}),
         delete: jest.fn().mockResolvedValue({}),
      };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            DeploymentService,
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn((key: string) => {
                     if (key === "FRONTEND_DEPLOY_PATH") return "/tmp/frontend";
                     if (key === "FRONTEND_URL") return "http://localhost:3000";
                     return null;
                  }),
               },
            },
            {
               provide: LoggerToDb,
               useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
            },
            {
               provide: EmailService,
               useValue: { sendEmail: jest.fn() },
            },
            {
               provide: FeatureFlagService,
               useValue: { isFeatureFlagDisabled: jest.fn().mockResolvedValue(false) },
            },
            {
               provide: REDIS_CACHE,
               useValue: {
                  get: jest.fn((key: string) => Promise.resolve(redisStore[key] || null)),
                  set: jest.fn((key: string, value: string) => { redisStore[key] = value; return Promise.resolve("OK"); }),
                  del: jest.fn((key: string) => { delete redisStore[key]; return Promise.resolve(1); }),
               },
            },
            {
               provide: getRepositoryToken(DeploymentProject),
               useValue: projectRepo,
            },
         ],
      }).compile();

      service = module.get<DeploymentService>(DeploymentService);
      emailService = module.get<EmailService>(EmailService);
      featureFlagService = module.get<FeatureFlagService>(FeatureFlagService);
      logger = module.get<LoggerToDb>(LoggerToDb);
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe("isRunning", () => {
      it("should return false when no deployment", async () => {
         expect(await service.isRunning()).toBe(false);
      });
   });

   describe("getCurrentDeployment", () => {
      it("should return null when no deployment", async () => {
         expect(await service.getCurrentDeployment()).toBeNull();
      });
   });

   describe("getLastDeployment", () => {
      it("should return null when no previous deployment", async () => {
         expect(await service.getLastDeployment()).toBeNull();
      });
   });

   describe("startDeployment", () => {
      it("should throw if deployment already in progress", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         await service.startDeployment("backend", "test");

         await expect(service.startDeployment("backend", "test")).rejects.toThrow("Deployment already in progress");
      });

      it("should throw if project not found", async () => {
         await expect(service.startDeployment("nonexistent", "test")).rejects.toThrow('Project "nonexistent" not found');
      });

      it("should return a Subject for SSE streaming", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         const subject = await service.startDeployment("backend", "admin");

         expect(subject).toBeDefined();
         expect(typeof subject.subscribe).toBe("function");
      });

      it("should set deployment state correctly", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         await service.startDeployment("backend", "github-webhook");

         const deployment = await service.getCurrentDeployment();
         expect(deployment).not.toBeNull();
         expect(deployment?.project).toBe("backend");
         expect(deployment?.triggeredBy).toBe("github-webhook");
         expect(deployment?.status).toBe("running");
         expect(deployment?.currentStep).toBeDefined();
         expect(deployment?.currentStep.step).toBe("git_pull");
      });
   });

   describe("deployment flow", () => {
      it("should block deployment if feature flag is disabled", async () => {
         (featureFlagService.isFeatureFlagDisabled as jest.Mock).mockResolvedValue(true);

         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         const subject = await service.startDeployment("backend", "test");
         const events: any[] = [];
         subject.subscribe((event) => events.push(JSON.parse((event as any).data)));

         await new Promise((r) => setTimeout(r, 50));

         expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("feature flag is disabled"));
         expect((await service.getCurrentDeployment())?.status).toBe("failed");
      });

      it("should send start email when deployment begins", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         await service.startDeployment("backend", "admin");

         await new Promise((r) => setTimeout(r, 50));

         expect(emailService.sendEmail).toHaveBeenCalledWith(
            expect.objectContaining({
               subject: "Shado Cloud - backend deployment started",
            }),
         );
      });

      it("should emit step events and complete successfully", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         const subject = await service.startDeployment("backend", "test");
         const events: any[] = [];
         subject.subscribe((event) => events.push(JSON.parse((event as any).data)));

         await new Promise((r) => setTimeout(r, 50));

         for (let i = 0; i < 6; i++) {
            mockProc.emit("close", 0);
            await new Promise((r) => setTimeout(r, 20));
         }

         const stepStarts = events.filter((e) => e.type === "step_start");
         const stepCompletes = events.filter((e) => e.type === "step_complete");
         expect(stepStarts.length).toBeGreaterThan(0);
         expect(stepCompletes.length).toBeGreaterThan(0);
      });

      it("should capture stdout output", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         const subject = await service.startDeployment("backend", "test");
         const events: any[] = [];
         subject.subscribe((event) => events.push(JSON.parse((event as any).data)));

         await new Promise((r) => setTimeout(r, 50));

         mockProc.stdout.emit("data", Buffer.from("test output"));
         await new Promise((r) => setTimeout(r, 20));

         const outputEvents = events.filter((e) => e.type === "step_output");
         expect(outputEvents.length).toBeGreaterThan(0);
         expect(outputEvents[0].output).toBe("test output");
      });
   });

   describe("getSubject", () => {
      it("should return null when no deployment", () => {
         expect(service.getSubject()).toBeNull();
      });

      it("should return subject during deployment", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         await service.startDeployment("backend", "test");

         expect(service.getSubject()).not.toBeNull();
      });
   });
});
