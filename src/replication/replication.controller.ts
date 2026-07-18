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
      // The replica self-reports its device name and mirror-disk count via headers; the
      // master combines device name + resolved client IP to identify it (handles two
      // replicas behind one IP). IP honors CF-Connecting-IP behind a tunnel.
      const header = (name: string): string | undefined => {
         const v = req.headers[name];
         return Array.isArray(v) ? v[0] : v;
      };
      const deviceName = header("x-replica-device");
      const rawMirrors = header("x-replica-mirrors");
      const mirrorDirs = rawMirrors !== undefined ? parseInt(rawMirrors, 10) : undefined;
      await this.replicationService.recordReplicaRequest(
         resolveClientIp(req),
         req.headers["user-agent"],
         Number.isFinite(mirrorDirs) ? mirrorDirs : undefined,
         deviceName,
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
