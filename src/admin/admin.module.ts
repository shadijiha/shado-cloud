import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "./../models/log";
import { User } from "./../models/user";

@Module({
	controllers: [AdminController],
	imports: [TypeOrmModule.forFeature([Log, User])],
	providers: [AdminService],
	exports: [AdminService],
})
export class AdminModule {}
