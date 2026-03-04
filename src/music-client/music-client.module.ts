import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { MusicProxyController } from "./music-proxy.controller";

@Module({
   imports: [HttpModule],
   controllers: [MusicProxyController],
})
export class MusicClientModule {}
