import { Controller, Get, Param } from "@nestjs/common";
import { ReplicationService } from "./replication.service";
import { ApiTags } from "@nestjs/swagger";

@Controller("replication")
@ApiTags("Replication")
export class ReplicationController {
   constructor(private readonly replicationService: ReplicationService) {}

   @Get("listall")
   public async listall() {
      return this.replicationService.listCloudDir();
   }

   @Get("sync")
   public async sync() {
      return this.replicationService.replicate();
   }

   @Get("getfile/:path")
   public async getFile(@Param("path") path: string) {
      return this.replicationService.getFile(path);
   }
}
