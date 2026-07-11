import { Body, Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { ApiTags } from "@nestjs/swagger";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { Response } from "express";

@Controller("replication")
@ApiTags("Replication")
export class ReplicationController {
   constructor(private readonly replicationService: ReplicationService) {}

   @Get("listall")
   @UseGuards(ServiceKeyGuard)
   public async listall() {
      return this.replicationService.listCloudDir();
   }

   @Get("sync")
   @UseGuards(ServiceKeyGuard)
   public async sync() {
      return this.replicationService.replicate();
   }

   @Get("getfile/:path")
   @UseGuards(ServiceKeyGuard)
   public async getFile(@Param("path") path: string, @Res() res: Response) {
      return this.replicationService.getFile(path, res);
   }
}
