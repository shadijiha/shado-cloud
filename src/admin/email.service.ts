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
                this.logger.warn("Unable to send email " + e.message);
            }
        }
    }

}