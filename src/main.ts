import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule, isDev } from "./app.module";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { GlobalExceptionFilter } from "./global.filter";
import helmet from "helmet";
import { LoggerToDb } from "./logging";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ConfigServiceInterceptor } from "./config/config.interceptor";
import { EnvVariables } from "./config/config.validator";

async function bootstrap() {
   const app = await NestFactory.create(AppModule);

   await ConfigModule.envVariablesLoaded;
   const envConfig = app.get<ConfigService<EnvVariables>>(ConfigService);

   app.enableCors({
      origin: [
         envConfig.get<string>("FRONTEND_URL"),
         /\.shadijiha\.com$/,
         "http://shadijiha.com",
         /https:\/\/\.shadijiha\.com$/,
      ],
      credentials: true,
   });
   app.useLogger(isDev(envConfig) ? ["log", "debug", "error", "verbose", "warn"] : ["error", "warn", "log"]);

   const config = new DocumentBuilder()
      .setTitle("Shado Cloud")
      .setDescription("The Shado Cloud API description")
      .setVersion("1.0")
      .addTag("")
      .addServer(
         envConfig.get<string>("BACKEND_HOST")?.startsWith("http")
            ? envConfig.get<string>("BACKEND_HOST")
            : `http://${envConfig.get<string>("BACKEND_HOST")}/`,
      )
      .addServer("https://cloud.shadijiha.com/apinest")
      .build();
   const document = SwaggerModule.createDocument(app, config);
   SwaggerModule.setup("api", app, document);
   // fs.writeFileSync("./swagger-spec.json", JSON.stringify(document));
   app.use(helmet());
   app.use(cookieParser());
   app.use(json({ limit: "100mb" }));
   app.use(urlencoded({ extended: true, limit: "100mb" }));
   app.useGlobalFilters(new GlobalExceptionFilter(await app.resolve(LoggerToDb)));
   app.useGlobalInterceptors(new ConfigServiceInterceptor(envConfig));

   await app.listen(9000);
}
bootstrap();
