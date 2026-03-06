import { Module } from "@nestjs/common";
import { GymController } from "./gym.controller";

@Module({
   controllers: [GymController],
})
export class GymClientModule {}
