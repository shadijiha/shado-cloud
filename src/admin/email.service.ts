import { Inject, Injectable, Logger } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom, timeout } from "rxjs";
import { EnvVariables } from "../config/config.validator";
import { AUTH_SERVICE } from "../auth/auth.constants";

/**
 * Email is sent centrally by shado-auth-api (which owns the SMTP transport).
 * This is a thin proxy that forwards send requests over the TCP microservice.
 * The public interface is unchanged so existing callers keep working.
 */
@Injectable()
export class EmailService {
   private readonly serviceKey: string;

   private readonly logger = new Logger(EmailService.name);

   public constructor(
      @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
      @Inject() private readonly config: ConfigService<EnvVariables>,
   ) {
      this.serviceKey = this.config.get("cross-service.secret", { infer: true });
   }

   public async sendEmail(options: { to?: string; subject: string; text?: string; html?: string; attachments?: any[] }) {
      try {
         const payload = {
            ...options,
            attachments: this.normalizeAttachments(options.attachments),
            serviceKey: this.serviceKey,
         };
         await firstValueFrom(this.authClient.send("send_email", payload).pipe(timeout(10_000)));
      } catch (e) {
         this.logger.warn("Unable to send email via auth-api: " + (e as Error).message);
      }
   }

   /**
    * TCP payloads are JSON-serialized, so binary content would arrive mangled
    * (a Buffer becomes {type:"Buffer",data:[...]} and a Uint8Array becomes
    * {"0":..,"1":..}) and break the attachment. Convert any binary `content`
    * (Buffer, Uint8Array/TypedArray, or ArrayBuffer — e.g. what Puppeteer v22+
    * `page.screenshot()` returns) to a base64 string + `encoding:"base64"`,
    * which survives JSON and is decoded natively by nodemailer on the auth-api side.
    */
   private normalizeAttachments(attachments?: any[]): any[] | undefined {
      if (!attachments?.length) return attachments;
      return attachments.map((att) => {
         const content = att?.content;
         if (Buffer.isBuffer(content)) {
            return { ...att, content: content.toString("base64"), encoding: "base64" };
         }
         if (content instanceof Uint8Array || ArrayBuffer.isView(content)) {
            // Covers Uint8Array and other TypedArray views (Puppeteer screenshots, etc.)
            return { ...att, content: Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64"), encoding: "base64" };
         }
         if (content instanceof ArrayBuffer) {
            return { ...att, content: Buffer.from(content).toString("base64"), encoding: "base64" };
         }
         return att;
      });
   }
}
