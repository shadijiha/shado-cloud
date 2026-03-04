import { Module } from "@nestjs/common";
import { DirectoriesController } from "./directories.controller";
import { StorageClientModule } from "../storage/storage-client.module";

@Module({
   imports: [StorageClientModule],
   controllers: [DirectoriesController],
})
export class DirectoriesModule {}
