import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DeploymentService } from "src/admin/deployment.service";
import { LoggerToDb } from "src/logging";
import { EmailService } from "src/admin/email.service";
import { FeatureFlagService } from "src/admin/feature-flag.service";
import { REDIS_CACHE } from "src/util";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

jest.mock("child_process");

describe("DeploymentService", () => {
   let service: DeploymentService;
   let emailService: EmailService;
   let featureFlagService: FeatureFlagService;
   let logger: LoggerToDb;
   const redisStore: Record<string, string> = {};

   beforeEach(async () => {
      // Clear redis store
      Object.keys(redisStore).forEach(k => delete redisStore[k]);

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
               useValue: {
                  log: jest.fn(),
                  warn: jest.fn(),
                  error: jest.fn(),
               },
            },
            {
               provide: EmailService,
               useValue: {
                  sendEmail: jest.fn(),
               },
            },
            {
               provide: FeatureFlagService,
               useValue: {
                  isFeatureFlagDisabled: jest.fn().mockResolvedValue(false),
               },
            },
            {
               provide: REDIS_CACHE,
               useValue: {
                  get: jest.fn((key: string) => Promise.resolve(redisStore[key] || null)),
                  set: jest.fn((key: string, value: string) => { redisStore[key] = value; return Promise.resolve("OK"); }),
                  del: jest.fn((key: string) => { delete redisStore[key]; return Promise.resolve(1); }),
               },
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

      it("should throw if frontend path not configured", async () => {
         const configService = { get: jest.fn().mockReturnValue(null) } as any;
         // @ts-expect-error
         service.config = configService;

         await expect(service.startDeployment("frontend", "test")).rejects.toThrow("FRONTEND_DEPLOY_PATH not configured");
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
         expect(deployment?.steps.length).toBeGreaterThan(0);
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

         // Wait for async feature flag check
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

         // Wait for async operations
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

         // Wait for first step to start
         await new Promise((r) => setTimeout(r, 50));

         // Simulate successful process completion for all steps
         for (let i = 0; i < 6; i++) {
            mockProc.emit("close", 0);
            await new Promise((r) => setTimeout(r, 20));
         }

         // Check events were emitted
         const stepStarts = events.filter((e) => e.type === "step_start");
         const stepCompletes = events.filter((e) => e.type === "step_complete");
         expect(stepStarts.length).toBeGreaterThan(0);
         expect(stepCompletes.length).toBeGreaterThan(0);
      });

      it("should handle step failure and send failure email", async () => {
         const mockProc = new EventEmitter() as any;
         mockProc.stdout = new EventEmitter();
         mockProc.stderr = new EventEmitter();
         (childProcess.spawn as jest.Mock).mockReturnValue(mockProc);

         const subject = await service.startDeployment("backend", "test");
         const events: any[] = [];
         subject.subscribe((event) => events.push(JSON.parse((event as any).data)));

         // Wait for first step to start
         await new Promise((r) => setTimeout(r, 50));

         // Simulate failure
         mockProc.emit("close", 1);
         await new Promise((r) => setTimeout(r, 50));

         expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Deployment failed"));
         expect(emailService.sendEmail).toHaveBeenCalledWith(
            expect.objectContaining({
               subject: expect.stringContaining("FAILED"),
            }),
         );
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
