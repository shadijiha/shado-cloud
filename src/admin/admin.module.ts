import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "./../models/log";
import { User } from "./../models/user";
import { AppMetricsService } from "./app-metrics.service";

@Module({
    controllers: [AdminController],
    imports: [TypeOrmModule.forFeature([Log, User])],
    providers: [AdminService, AppMetricsService],
    exports: [AdminService],
})
export class AdminModule {}
