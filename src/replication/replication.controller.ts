import { Body, Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { ApiTags } from "@nestjs/swagger";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { Request, Response } from "express";
import { resolveClientIp } from "./client-ip.util";

@Controller("replication")
@ApiTags("Replication")
export class ReplicationController {
   constructor(private readonly replicationService: ReplicationService) {}

   @Get("listall")
   @UseGuards(ServiceKeyGuard)
   public async listall(@Req() req: Request) {
      // Record the replica that requested replication (master keeps this registry).
      // Resolves the real client IP (honors CF-Connecting-IP behind a cloudflared tunnel).
      await this.replicationService.recordReplicaRequest(resolveClientIp(req), req.headers["user-agent"]);
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

   @Get("database")
   @UseGuards(ServiceKeyGuard)
   public async getDatabase(@Res() res: Response) {
      return this.replicationService.getDatabaseDump(res);
   }
}
