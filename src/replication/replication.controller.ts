import { Body, Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ServiceKeyGuard } from "src/auth/service-key.guard";
import { Request, Response } from "express";
import { resolveClientIp } from "./client-ip.util";

/**
 * HTTP endpoints the REPLICA pulls from (all master-served). Every route is
 * service-to-service only: authenticated by {@link ServiceKeyGuard} (per-request HMAC)
 * and additionally restricted to allow-listed IPs by TrustedIpMiddleware (wired in the
 * module). Throttling is skipped because a single sync legitimately pulls thousands of
 * files from one peer IP, which the public per-IP rate limit would otherwise block.
 */
@Controller("replication")
@ApiTags("Replication")
@SkipThrottle()
export class ReplicationController {
   constructor(private readonly replicationService: ReplicationService) {}

   /** Master: list every file in cloud-dir, and record the calling replica in the registry. */
   @Get("listall")
   @UseGuards(ServiceKeyGuard)
   public async listall(@Req() req: Request) {
      // The replica self-reports how many mirror disks it has via a header; store it
      // alongside the resolved client IP (honors CF-Connecting-IP behind a tunnel).
      const mirrorsHeader = req.headers["x-replica-mirrors"];
      const rawMirrors = Array.isArray(mirrorsHeader) ? mirrorsHeader[0] : mirrorsHeader;
      const mirrorDirs = rawMirrors !== undefined ? parseInt(rawMirrors, 10) : undefined;
      await this.replicationService.recordReplicaRequest(
         resolveClientIp(req),
         req.headers["user-agent"],
         Number.isFinite(mirrorDirs) ? mirrorDirs : undefined,
      );
      return this.replicationService.listCloudDir();
   }

   /** Manually trigger a replication pass (normally driven by the per-minute cron). */
   @Get("sync")
   @UseGuards(ServiceKeyGuard)
   public async sync() {
      return this.replicationService.replicate();
   }

   /** Master: stream one file, encrypted, to the replica. */
   @Get("getfile/:path")
   @UseGuards(ServiceKeyGuard)
   public async getFile(@Param("path") path: string, @Res() res: Response) {
      return this.replicationService.getFile(path, res);
   }

   /** Master: stream an encrypted dump of all databases to the replica. */
   @Get("database")
   @UseGuards(ServiceKeyGuard)
   public async getDatabase(@Res() res: Response) {
      return this.replicationService.getDatabaseDump(res);
   }
}
