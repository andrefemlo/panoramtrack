import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { HealthController } from "./health.controller";
import { TrackingController } from "./tracking.controller";
import { TrackingService } from "./tracking.service";
import { EvolutionWebhookController } from "./evolution-webhook.controller";
import { EvolutionWebhookService } from "./evolution-webhook.service";

@Module({
  controllers: [
    HealthController,
    TrackingController,
    EvolutionWebhookController,
  ],
  providers: [PrismaService, TrackingService, EvolutionWebhookService],
})
export class AppModule {}
