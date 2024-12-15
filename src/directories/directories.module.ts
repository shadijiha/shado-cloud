import { Module } from "@nestjs/common";
import { DirectoriesController } from "./directories.controller";
import { DirectoriesService } from "./directories.service";
import { FilesModule } from "src/files/files.module";
import { AuthModule } from "src/auth/auth.module";

@Module({
	imports: [FilesModule, AuthModule],
	controllers: [DirectoriesController],
	providers: [DirectoriesService],
	exports: [DirectoriesService],
})
export class DirectoriesModule {}
