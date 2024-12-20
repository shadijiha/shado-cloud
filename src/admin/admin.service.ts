import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { exec, type ExecException } from "child_process";
import { Log } from "src/models/log";
import { In, Repository } from "typeorm";

@Injectable()
export class AdminService {
   public constructor(@InjectRepository(Log) private readonly logRepo: Repository<Log>) {}

   public async all() {
      return (await this.logRepo.find({ relations: ["user"] })).sort((a, b) => {
         return b.created_at.getTime() - a.created_at.getTime();
      });
   }

   public async deleteByIds(ids: number[]) {
      await this.logRepo.delete(ids);
   }

   public async redeploy() {
      const result = await cmd("./deploy");
      return { result };
   }
}

// Helper
async function cmd(command: string): Promise<ExecException | string> {
   return await new Promise((resolve, reject) => {
      exec(command, (err, stdout, stderr) => {
         if (err) {
            reject(err);
            return;
         }

         // the *entire* stdout and stderr (buffered)
         resolve(stdout);
      });
   });
}
