import { Inject, Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import { ConfigService } from "@nestjs/config";
import { EnvVariables } from "../config/config.validator";
import { LoggerToDb } from "../logging";

@Injectable()
export class EmailService {
    private transporter: nodemailer.Transporter | undefined;

    public constructor(
        @Inject() private readonly logger: LoggerToDb,
        @Inject() private readonly config: ConfigService<EnvVariables>,
    ) {
        const email = this.config.get("this-service.google.email", { infer: true });
        const clientId = this.config.get("this-service.google.client-id", { infer: true });
        const refreshToken = this.config.get("this-service.google.refresh-token", { infer: true });

        if (email && clientId && refreshToken) {
            this.transporter = nodemailer.createTransport({
                host: "smtp.gmail.com",
                port: 465,
                secure: true,
                auth: {
                    type: "OAuth2",
                    user: config.get("this-service.google.email", { infer: true }),
                    clientId: config.get("this-service.google.client-id", { infer: true }),
                    clientSecret: config.get("this-service.google.client-secret", { infer: true }),
                    refreshToken: config.get("this-service.google.refresh-token", { infer: true }),
                },
            });
        } else {
            this.logger.warn(
                "Emails won't be sent because .env email or password are either undefined or not escaped properly",
            );
        }
    }

    public async sendEmail(options: { to?: string, subject: string; text?: string; html?: string, attachments?: any[] }) {
        if (this.transporter) {
            try {
                await this.transporter.sendMail({
                    from: this.config.get("this-service.google.email", { infer: true }), // Sender address
                    to: options.to ?? this.config.get("this-service.google.email", { infer: true }), // Receiver's address
                    subject: options.subject, // Subject line
                    text: options.text, // Plain text body
                    html: options.html,
                    attachments: options.attachments,
                });
            } catch (e) {
                this.logger.warn("Unable to send email " + (e as Error).message);
            }
        }
    }

}