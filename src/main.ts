import "reflect-metadata";
require("dotenv-safe").config({ allowEmptyValues: true });
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { GlobalExceptionFilter } from "./global.filter";
import helmet from "helmet";

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		cors: {
			origin: [
				process.env.FRONTEND_URL,
				/\.shadijiha\.com$/,
				"http://shadijiha.com",
				/https:\/\/\.shadijiha\.com$/,
			],
			credentials: true,
		},
	});

	const config = new DocumentBuilder()
		.setTitle("Shado Cloud")
		.setDescription("The Shado Cloud API description")
		.setVersion("1.0")
		.addTag("")
		.addServer(process.env.BACKEND_HOST)
		.build();
	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup("api", app, document);
	//fs.writeFileSync("./swagger-spec.json", JSON.stringify(document));
	app.use(helmet());
	app.use(cookieParser());
	app.use(json({ limit: "100mb" }));
	app.use(urlencoded({ extended: true, limit: "100mb" }));
	app.useGlobalFilters(new GlobalExceptionFilter());

	await app.listen(9000);
}
bootstrap();
