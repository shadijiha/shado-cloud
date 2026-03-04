import { forwardRef, Module } from "@nestjs/common";
import { FilesConstoller } from "./files.controller";
import { FilesService } from "./files.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "src/auth/auth.module";
import { SearchStat } from "src/models/stats/searchStat";
import { ThumbnailCacheInterceptor } from "./thumbnail-cache.interceptor";
import { InternalController } from "./internal.controller";
import { DirectoriesModule } from "src/directories/directories.module";

@Module({
   imports: [TypeOrmModule.forFeature([SearchStat]), AuthModule, forwardRef(() => DirectoriesModule)],
   controllers: [FilesConstoller, InternalController],
   providers: [FilesService, ThumbnailCacheInterceptor],
   exports: [FilesService],
})
export class FilesModule {}
