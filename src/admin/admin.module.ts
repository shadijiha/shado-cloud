import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "./../models/log";
import { User } from "./../models/user";
import { AppMetricsService } from "./app-metrics.service";
import { FeatureFlagService } from "./feature-flag.service";
import { FeatureFlag } from "src/models/admin/featureFlag";
import { EncryptedPassword } from "src/models/EncryptedPassword";

@Module({
   controllers: [AdminController],
   imports: [TypeOrmModule.forFeature([Log, User, FeatureFlag])],
   providers: [AdminService, AppMetricsService, FeatureFlagService],
   exports: [AdminService],
})
export class AdminModule {}
