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
        const email = this.config.get<string | undefined>("EMAIL_USER");
        const clientId = this.config.get<string | undefined>("GOOGLE_CLIENT_ID");
        const refreshToken = this.config.get<string | undefined>("GOOGLE_REFRESH_TOKEN");

        if (email && clientId && refreshToken) {
            this.transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    type: "OAuth2",
                    user: config.get("EMAIL_USER"),
                    clientId: config.get("GOOGLE_CLIENT_ID"),
                    clientSecret: config.get("GOOGLE_CLIENT_SECRET"),
                    refreshToken: config.get("GOOGLE_REFRESH_TOKEN"),
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
                    from: this.config.get<string>("EMAIL_USER"), // Sender address
                    to: options.to ?? this.config.get<string>("EMAIL_USER"), // Receiver's address
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