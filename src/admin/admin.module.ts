import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "./../models/log";
import { User } from "./../models/user";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlag } from "src/models/admin/featureFlag";
import { ServiceFunctionsController } from "./service-functions/service-functions.controller";
import { ServiceFunction } from "../models/admin/serviceFunction";
import { FilesModule } from "../files/files.module";
import { EmailService } from "./email.service";
import { DirectoriesModule } from "../directories/directories.module";
import { RemoteDesktopGateway } from "./remote-desktop.gateway";
import { RemoteTerminalGateway } from "./remote-terminal.gateway";
import { DeploymentController } from "./deployment.controller";
import { DeploymentService } from "./deployment.service";
import { DeploymentProject } from "../models/admin/deploymentProject";
import { TwoFactorGuard } from "./two-factor.guard";
import { CronAdminService } from "./cron.service";

@Module({
   controllers: [AdminController, ServiceFunctionsController, DeploymentController],
   imports: [TypeOrmModule.forFeature([Log, User, FeatureFlag, ServiceFunction, DeploymentProject]),
      FilesModule,
      DirectoriesModule
   ],
   providers: [AdminService, FeatureFlagService, EmailService, RemoteDesktopGateway, RemoteTerminalGateway, DeploymentService, TwoFactorGuard, CronAdminService],
   exports: [AdminService],
})
export class AdminModule { }
