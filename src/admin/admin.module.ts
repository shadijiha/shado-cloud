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
import { FilesModule } from "../files/files.module";
import { EmailService } from "./email.service";
import { DirectoriesModule } from "../directories/directories.module";

@Module({
   controllers: [AdminController, ServiceFunctionsController],
   imports: [TypeOrmModule.forFeature([Log, User, FeatureFlag, ServiceFunction]), FilesModule, DirectoriesModule],
   providers: [AdminService, AppMetricsService, FeatureFlagService, EmailService],
   exports: [AdminService],
})
export class AdminModule { }
