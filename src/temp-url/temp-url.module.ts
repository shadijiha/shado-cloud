import { Module } from "@nestjs/common";
import { TempUrlConstoller } from "./tempUrl.controller";
import { StorageClientModule } from "../storage/storage-client.module";

@Module({
   imports: [StorageClientModule],
   controllers: [TempUrlConstoller],
})
export class TempUrlModule {}
