import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { exec } from "child_process";
import { LoggerToDb } from "../logging";
import { Log } from "../models/log";
import { Repository } from "typeorm";
import nodemailer from "nodemailer";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { promisify } from "util";

@Injectable()
export class AdminService {
   private transporter: nodemailer.Transporter | undefined;

   public constructor(
      @InjectRepository(Log) private readonly logRepo: Repository<Log>,
      @Inject() private readonly logger: LoggerToDb,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {
      const email = this.config.get<string | undefined>("EMAIL_USER");
      const password = this.config.get<string | undefined>("EMAIL_APP_PASSWORD");

      // We only want to send emails if credentials are defined in the env
      if (email && password) {
         this.transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
               user: config.get("EMAIL_USER"), // Your email address
               pass: config.get("EMAIL_APP_PASSWORD"), // Your email password (or app-specific password)
            },
         });
      } else {
         this.logger.warn(
            "Emails won't be sent because .env email or password are either undefined or not escaped properly",
         );
      }
   }

   public async all() {
      return (await this.logRepo.find({ relations: ["user"] })).sort((a, b) => {
         return b.created_at.getTime() - a.created_at.getTime();
      });
   }

   public async deleteByIds(ids: number[]) {
      await this.logRepo.delete(ids);
   }

   public async redeploy(type: "backend" | "frontend") {
      // We can't have a promise that resolves / rejects because github webhooks have a 10 second timeout
      // there for we'll only acknowladge to github webhooks. If there's an error, it will be logged only
      // Github won't know about it

      // Send email for deployment start
      this.sendEmail({
         subject: "Shado Cloud - deployment start",
         text: "Deployment was triggered for Shado Cloud nestjs app",
      });

      // Check and log the node version
      const nodeVersion = (await this.execSync("node -v")).stdout;
      this.logger.log(`[${AdminService.name}:${this.redeploy.name}(type=${type})] Node version: ${nodeVersion}`);

      // Check if FRONTEND_DEPLOY_PATH is set
      if (type == "frontend" && !this.config.get("FRONTEND_DEPLOY_PATH")) {
         this.logger.error(
            `[${AdminService.name}:${this.redeploy.name}(type=${type})] attempt to redeploy while FRONTEND_DEPLOY_PATH is not set`,
         );
         return;
      }

      const dirpath = type == "backend" ? __dirname : this.config.get<string>("FRONTEND_DEPLOY_PATH");
      const fullcommand = `${dirpath}/deploy.sh`;
      const result = exec(fullcommand);

      result.stdout.on("data", (data) => {
         this.logger.log(data);
      });
      result.stderr.on("data", (data) => {
         this.logger.error(data);
      });

      const exitFn = async (code) => {
         if (code == 0) {
            this.logger.log(`${fullcommand} exited successfully`);
            await this.sendEmail({
               subject: "Shado Cloud - Successful deployment",
               html: "<h2>Shado cloud nestjs app has succesfully deployed!</h2>",
            });
         } else {
            this.logger.error(`${fullcommand} exited with code ${code}`);
            await this.sendEmail({
               subject: "Shado Cloud - Failed deployment",
               html: `
               <h2>Shado cloud nestjs app has failed</h2>
               <code>
                  ${fullcommand} exited with code ${code}
               </code>
               `,
            });
         }
      };

      result.on("close", exitFn);
      result.on("exit", exitFn);
      result.on("disconnect", exitFn);
   }

   private async sendEmail(options: { subject: string; text?: string; html?: string }) {
      if (this.transporter) {
         try {
            await this.transporter.sendMail({
               from: this.config.get<string>("EMAIL_USER"), // Sender address
               to: this.config.get<string>("EMAIL_USER"), // Receiver's address
               subject: options.subject, // Subject line
               text: options.text, // Plain text body
               html: options.html,
            });
         } catch (e) {
            this.logger.warn("Unable to send deployment email " + e.message);
         }
      }
   }

   private async execSync(command: string) {
      return promisify(exec)(command);
   }
}
