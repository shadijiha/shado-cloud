import "reflect-metadata";
require("dotenv-safe").config({ allowEmptyValues: true });
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import cookieParser from "cookie-parser";
import fs from "fs";
import { Logger, ValidationPipe } from "@nestjs/common";

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		cors: {
			origin: process.env.FRONTEND_URL,
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
	app.use(cookieParser());
	await app.listen(9000);
}
bootstrap();
