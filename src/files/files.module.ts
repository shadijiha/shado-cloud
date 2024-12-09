import { Module } from "@nestjs/common";
import { FilesConstoller } from "./files.controller";
import { FilesService } from "./files.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "src/auth/auth.module";
import { SearchStat } from "src/models/stats/searchStat";

@Module({
	imports: [TypeOrmModule.forFeature([SearchStat]), AuthModule],
	controllers: [FilesConstoller],
	providers: [FilesService],
	exports: [FilesService],
})
export class FilesModule {}
