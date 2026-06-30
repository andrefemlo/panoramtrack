import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: "25mb" }));
  app.use(urlencoded({ extended: true, limit: "25mb" }));

  app.enableCors();

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, "0.0.0.0");

  console.log(`crmpanoramtrack api running on port ${port}`);
}

bootstrap();
