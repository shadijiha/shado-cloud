import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "./../models/log";
import { User } from "./../models/user";
import { AppMetricsService } from "./app-metrics.service";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlag } from "src/models/admin/featureFlag";
import { ServiceFunctionsController } from "./service-functions/service-functions.controller";
import { ServiceFunction } from "../models/admin/serviceFunction";
import { EmailService } from "./email.service";
import { RemoteDesktopGateway } from "./remote-desktop.gateway";
import { AuthService } from "../auth/auth.service";
import { DeploymentService } from "./deployment.service";
import { DeploymentProject } from "../models/admin/deploymentProject";
import { StorageClientModule } from "../storage/storage-client.module";

@Module({
   controllers: [AdminController, ServiceFunctionsController],
   imports: [TypeOrmModule.forFeature([Log, User, FeatureFlag, ServiceFunction, DeploymentProject]), StorageClientModule],
   providers: [AdminService, AppMetricsService, FeatureFlagService, EmailService, RemoteDesktopGateway, AuthService, DeploymentService],
   exports: [AdminService],
})
export class AdminModule {}
