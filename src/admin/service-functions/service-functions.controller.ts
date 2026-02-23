import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Logger, Inject, Delete, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { AdminGuard } from "../admin.strategy";
import { InjectRepository } from "@nestjs/typeorm";
import { ServiceFunction } from "../../models/admin/serviceFunction";
import { Repository } from "typeorm";
import { AuthUser } from "src/util";
import { Cron, CronExpression } from "@nestjs/schedule";
import { type Readable } from "stream";
import vm from "vm";
import { FilesService } from "../../files/files.service";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { EmailService } from "../email.service";
import { FeatureFlagService } from "../feature-flag.service";
import { FeatureFlagNamespace } from "../../models/admin/featureFlag";
import { DirectoriesService } from "../../directories/directories.service";
import { basename, dirname } from "path";

puppeteer.use(StealthPlugin());

@Controller("admin/service_functions")
@UseGuards(AuthGuard("jwt"), AdminGuard)
export class ServiceFunctionsController {
    private readonly logger = new Logger(ServiceFunctionsController.name);

    constructor(
        @InjectRepository(ServiceFunction) private readonly serviceFuncRepo: Repository<ServiceFunction>,
        @Inject() private readonly fileService: FilesService,
        @Inject() private readonly emailService: EmailService,
        @Inject() private readonly featureFlag: FeatureFlagService,
        @Inject() private readonly directoriesService: DirectoriesService,
    ) { }

    @Get("all")
    public async all(@AuthUser() userId: number) {
        return this.serviceFuncRepo.find({
            where: {
                user_id: userId
            }
        });
    }

    @Post("/create")
    public async create(
        @AuthUser() userId: number,
        @Body() body: { code: string, name?: string }
    ) {
        const func = new ServiceFunction();
        func.code = body.code;
        func.name = body.name ?? null;
        func.user_id = userId;

        await this.serviceFuncRepo.save(func);
        return func;
    }

    @Get(":id/get")
    public async get(
        @AuthUser() userId: number,
        @Param("id") id: string
    ) {
        const func = await this.serviceFuncRepo.findOne({
            where: {
                user_id: userId,
                id
            }
        });

        if (!func) {
            throw new HttpException("Invalid service function id", HttpStatus.BAD_REQUEST);
        }
        return func;
    }

    @Post(":id/save")
    public async save(
        @AuthUser() userId: number,
        @Param("id") id: string,
        @Body() body: { code: string, name?: string, enabled?: boolean }
    ) {
        const func = await this.serviceFuncRepo.findOne({
            where: {
                user_id: userId,
                id
            }
        });

        if (!func) {
            throw new HttpException("Invalid service function id", HttpStatus.BAD_REQUEST);
        }

        func.code = body.code;
        if (body.name) {
            func.name = body.name
        }
        if (body.enabled != null || body.enabled != undefined) {
            func.enabled = body.enabled;
        }
        await this.serviceFuncRepo.save(func);
    }

    @Post(":id/execute")
    public async execute(
        @AuthUser() userId: number,
        @Param("id") id: string,
    ) {
        const func = await this.serviceFuncRepo.findOne({
            where: {
                user_id: userId,
                id
            }
        });

        if (!func) {
            throw new HttpException("Invalid service function id", HttpStatus.BAD_REQUEST);
        }

        await this.executeFunction(func);
    }

    @Delete(":id/delete")
    public async delete(
        @AuthUser() userId: number,
        @Param("id") id: string,
    ) {
        const func = await this.serviceFuncRepo.findOne({
            where: {
                user_id: userId,
                id
            }
        });

        if (!func) {
            throw new HttpException("Invalid service function id", HttpStatus.BAD_REQUEST);
        }

        await this.serviceFuncRepo.remove(func);
    }

    @Cron(CronExpression.EVERY_HOUR)
    public async executeFunctions() {
        const funcs = await this.serviceFuncRepo.find({
            where: {
                enabled: true,
            },
            order: {
                avg_execution_time_ms: 'ASC',
            },
        });

        if (funcs.length <= 0) {
            return;
        }

        for (const func of funcs) {
            // The use await here is deliberate. Some service functions use puppeteer which on rasberry pie CPU spike to 100%.
            // Tis makes the device unresponsive. By making functions run sequentially, this risk is lowered
            await this.executeFunction(func);
        }
    }

    private async executeFunction(func: ServiceFunction) {
        // helper function for logging 
        const formatLog = (level, msg) => {
            const now = new Date();
            const timestamp = now.toISOString().replace('T', ' ').split('.')[0];
            // Example: 2026-02-22 14:32:10
            const formatted = `[${timestamp}] ${level.toUpperCase()}: ${msg}\n`;
            return formatted;
        }

        if (!await this.featureFlag.isFeatureFlagEnabled(FeatureFlagNamespace.Admin, "enable_service_functions_execution")) {
            const msg = `Cannot execute service function ${func.id} for user ${func.user_id}. ${FeatureFlagNamespace.Admin}.enable_service_functions_execution feature flag is disabled`;
            this.logger.log(msg);
            func.last_execution_logs = formatLog("Error", msg);
            await this.serviceFuncRepo.save(func);
            return;
        }

        this.logger.log(`Running service function ${func.id} for user ${func.user_id}`);
        const startTime = Date.now();

        func.last_execution_logs = "";
        await this.serviceFuncRepo.save(func);

        const context = {
            fetch: fetch,
            setTimeout: setTimeout,
            setInterval: setInterval,
            console: {
                log: async e => {
                    this.logger.log(e);
                    func.last_execution_logs += formatLog("Info", e);
                    this.serviceFuncRepo.save(func);
                },
                error: e => {
                    this.logger.error(e);
                    func.last_execution_logs += formatLog("Error", e);
                    this.serviceFuncRepo.save(func);
                },
                warn: e => {
                    this.logger.warn(e);
                    func.last_execution_logs += formatLog("Warn", e);
                    this.serviceFuncRepo.save(func);
                },
            },
            fs: {
                readFileAsync: async (path: string) => this.streamToString(await this.fileService.asStream(func.user_id, path, `service-func-${func.id}`)),
                writeFileAsync: (path: string, content: string, append?: boolean) => this.fileService.save(func.user_id, path, content, append),
                writeImageAsync: (path: string, content: Buffer, mime?: string) => this.fileService.upload(func.user_id, {
                    originalname: basename(path),
                    buffer: content,
                    mimetype: mime ?? 'image/png',
                    size: content.length,
                } as any, dirname(path)),
                readImageAsync: async (path: string) => this.streamToBuffer(await this.fileService.asStream(func.user_id, path, `service-func-${func.id}`)),
                deleteFileAsync: (path: string) => this.fileService.delete(func.user_id, path),
                existsAsync: (path: string) => this.fileService.exists(func.user_id, path),
                mkdirAsync: (path: string) => this.directoriesService.new(func.user_id, path),
                deleteDirAsync: (path: string) => this.directoriesService.delete(func.user_id, path),
                listFilesAsync: (path: string) => this.directoriesService.list(func.user_id, path),
            },
            puppeteer: puppeteer,
            sendEmail: e => this.emailService.sendEmail(e),
            self: {
                ...func,
                storage: {
                    get: () => func.storage,
                    set: async (str) => {
                        func.storage = str;
                        await this.serviceFuncRepo.save(func);
                    }
                }
            },
        }

        try {
            const result = vm.runInNewContext(`${func.code}`, {
                ...context,
                global: this.safeStringify(context)
            });
            if (result instanceof Promise) {
                await result;
            }
        } catch (error: any) {
            this.logger.error(error.message);
            func.last_execution_logs += formatLog("Error", error.message);
        } finally {
            const endTime = Date.now();
            const execTime = endTime - startTime;
            func.last_execution_time_ms = execTime;
            func.avg_execution_time_ms = !func.avg_execution_time_ms ? execTime : (func.avg_execution_time_ms * func.execution_count + execTime) / (func.execution_count + 1);
            func.execution_count += 1;
            await this.serviceFuncRepo.save(func);
        }
    }

    private streamToString(stream: Readable): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';

            stream.on('data', chunk => {
                data += chunk;
            });

            stream.on('end', () => {
                resolve(data);
            });

            stream.on('error', err => {
                reject(err);
            });
        });
    }

    private streamToBuffer(stream: Readable): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', (err) => reject(err));
        });
    }

    private safeStringify(obj: any): string {
        const seen = new WeakSet();

        function replacer(key: string, value: any) {
            // Handle Puppeteer objects explicitly
            if (
                value &&
                typeof value === "object" &&
                value.constructor &&
                value.constructor.name.includes("Puppeteer")
            ) {
                return "[Object puppeteer browser npm]";
            } else if (
                value &&
                typeof value === "object" &&
                value.constructor &&
                value.constructor.name.includes("opencv")
            ) {
                return "[Object OpenCV browser npm]";
            }

            // Handle functions
            if (typeof value === "function") {
                return value.name
                    ? `function ${value.name}() { /* ... */ }`
                    : value.toString();
            }

            // Handle circular references
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) {
                    return "[Circular]";
                }
                seen.add(value);
            }

            return value;
        }

        try {
            return JSON.stringify(obj, replacer, 2);
        } catch (e) {
            return `[Unserializable: ${e}]`;
        }
    }
}