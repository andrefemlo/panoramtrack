import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { HealthController } from "./health.controller";
import { TrackingController } from "./tracking.controller";
import { TrackingService } from "./tracking.service";
import { EvolutionWebhookController } from "./evolution-webhook.controller";
import { EvolutionWebhookService } from "./evolution-webhook.service";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";

@Module({
  controllers: [
    HealthController,
    TrackingController,
    EvolutionWebhookController,
    LeadsController,
  ],
  providers: [
    PrismaService,
    TrackingService,
    EvolutionWebhookService,
    LeadsService,
  ],
})
export class AppModule {}
