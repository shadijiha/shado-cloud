import { Module } from "@nestjs/common";
import { FilesConstoller } from "./files.controller";
import { StorageClientModule } from "../storage/storage-client.module";

@Module({
   imports: [StorageClientModule],
   controllers: [FilesConstoller],
})
export class FilesModule {}
