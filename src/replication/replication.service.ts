import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleInit, StreamableFile } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { lastValueFrom } from "rxjs";
import { EnvVariables, ReplicationRole } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import * as path from "path";

@Injectable()
export class ReplicationService implements OnModuleInit {
   private readonly logger = new Logger(ReplicationService.name);
   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly httpService: HttpService,
      private readonly fs: AbstractFileSystem,
   ) {}

   public onModuleInit() {
      this.replicate();
   }

   @Cron(CronExpression.EVERY_HOUR)
   public async replicate() {
      try {
         if (this.isReplica()) {
            this.logger.log("Replicating data from master...");

            if (!this.config.get("MASTER_OR_REPLICA_LOCAL_IP")) {
               this.logger.error("Master IP is not set");
               return;
            }

            const masterIp = "http://" + this.config.get("MASTER_OR_REPLICA_LOCAL_IP");
            const replicaFiles = this.listCloudDir();
            const masterFiles: typeof replicaFiles = (
               await lastValueFrom(this.httpService.get(`${masterIp}/replication/listall`))
            ).data;

            // Files to replicate
            const replicaDoesNotHave = masterFiles.filter((e) => !replicaFiles.find((f) => f.path == e.path));
            this.logger.log(`${replicaDoesNotHave.length} Files to replicate`);

            let filesReplicated = 0;
            for (const file of replicaDoesNotHave) {
               if (!this.fs.existsSync(path.join(this.cloudDir, file.path))) {
                  this.fs.mkdirSync(path.join(this.cloudDir, path.dirname(file.path)), { recursive: true });
               }
               const response = await lastValueFrom(
                  this.httpService.get(`${masterIp}/replication/getfile/${encodeURIComponent(file.path)}`, {
                     responseType: "arraybuffer",
                  }),
               );
               const filePath = path.join(this.cloudDir, file.path);
               this.fs.writeFileSync(filePath, response.data);

               this.logger.log(`Done ${filesReplicated + 1} of ${replicaDoesNotHave.length} files`);
               filesReplicated++;
            }

            // Files to delete
            const masterDoesNotHave = replicaFiles.filter((e) => !masterFiles.find((f) => f.path == e.path));
            this.logger.log(`${masterDoesNotHave.length} Files to delete`);
            for (const file of masterDoesNotHave) {
               this.fs.unlinkSync(path.join(this.cloudDir, file.path));
            }
         } else if (this.isMaster()) {
            // No op
         } else {
            this.logger.error(`Replication role is unknown ${this.config.get("REPLICATION_ROLE")}`);
         }
      } catch (error) {
         const e = error as Error;
         const fullMessage = `${this.config.get("REPLICATION_ROLE")} encountered an exception: ${e.message}`;
         this.logger.error(fullMessage, e.stack);
      }
   }

   public listCloudDir() {
      return this.listRecusively(this.cloudDir);
   }

   public getFile(path_: string) {
      return new StreamableFile(this.fs.createReadStream(path.join(this.cloudDir, path_)));
   }

   private listRecusively(path_: string) {
      const entries = this.fs.readdirSync(path_);

      // Get files within the current directory and add a path key to the file objects
      const files = entries
         .filter((file) => !file.isDirectory())
         .map((file) => ({ ...file, path: path.relative(this.config.get("CLOUD_DIR"), path_ + "/" + file.name) }));

      // Get folders within the current directory
      const folders = entries.filter((folder) => folder.isDirectory());

      /*
       * Add the found files within the subdirectory to the files array by calling the
       * current function itself
       */
      for (const folder of folders) {
         files.push(...this.listRecusively(`${path_}/${folder.name}/`));
      }

      return files;
   }

   private isMaster() {
      return this.config.get("REPLICATION_ROLE") == ReplicationRole.Master;
   }

   private isReplica() {
      return this.config.get("REPLICATION_ROLE") == ReplicationRole.Replica;
   }

   private get cloudDir() {
      return this.config.get("CLOUD_DIR");
   }
}
