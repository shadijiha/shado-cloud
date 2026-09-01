import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./../models/user";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlag } from "src/models/admin/featureFlag";
import { ServiceFunctionsController } from "./service-functions/service-functions.controller";
import { ServiceFunction } from "../models/admin/serviceFunction";
import { FilesModule } from "../files/files.module";
import { EmailService } from "./email.service";
import { DirectoriesModule } from "../directories/directories.module";
import { RemoteTerminalGateway } from "./remote-terminal.gateway";
import { DeploymentController } from "./deployment.controller";
import { DeploymentService } from "./deployment.service";
import { DeploymentProject } from "../models/admin/deploymentProject";
import { TwoFactorGuard } from "./two-factor.guard";
import { CronAdminService } from "./cron.service";
import { PipelineController } from "./pipelines/pipeline.controller";
import { PipelineService } from "./pipelines/pipeline.service";
import { PipelineConfigService } from "./pipelines/pipeline-config.service";
import { PromotionBlockerService } from "./pipelines/promotion-blocker.service";
import { StepRunnerService } from "./pipelines/step-runner.service";
import { Pipeline } from "../models/admin/pipeline/pipeline";
import { PipelineWave } from "../models/admin/pipeline/pipelineWave";
import { PipelineStage } from "../models/admin/pipeline/pipelineStage";
import { PipelineTarget } from "../models/admin/pipeline/pipelineTarget";
import { PipelinePromotion } from "../models/admin/pipeline/pipelinePromotion";
import { PipelinePromotionBlocker } from "../models/admin/pipeline/pipelinePromotionBlocker";
import { ApprovalWorkflow } from "../models/admin/pipeline/approvalWorkflow";
import { ApprovalWorkflowStep } from "../models/admin/pipeline/approvalWorkflowStep";
import { PipelineRun } from "../models/admin/pipeline/pipelineRun";

@Module({
   controllers: [AdminController, ServiceFunctionsController, DeploymentController, PipelineController],
   imports: [TypeOrmModule.forFeature([
      User,
      FeatureFlag,
      ServiceFunction,
      DeploymentProject,
      Pipeline,
      PipelineWave,
      PipelineStage,
      PipelineTarget,
      PipelinePromotion,
      PipelinePromotionBlocker,
      ApprovalWorkflow,
      ApprovalWorkflowStep,
      PipelineRun,
   ]),
      FilesModule,
      DirectoriesModule
   ],
   providers: [
      AdminService,
      FeatureFlagService,
      EmailService,
      RemoteTerminalGateway,
      DeploymentService,
      TwoFactorGuard,
      CronAdminService,
      StepRunnerService,
      PromotionBlockerService,
      PipelineConfigService,
      PipelineService,
   ],
   exports: [AdminService],
})
export class AdminModule { }
