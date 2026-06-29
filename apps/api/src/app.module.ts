import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { HealthController } from "./health.controller";
import { TrackingController } from "./tracking.controller";
import { TrackingService } from "./tracking.service";
import { EvolutionWebhookController } from "./evolution-webhook.controller";
import { EvolutionWebhookService } from "./evolution-webhook.service";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { WhatsappSyncController } from "./whatsapp-sync.controller";
import { WhatsappSyncService } from "./whatsapp-sync.service";

@Module({
  controllers: [
    HealthController,
    TrackingController,
    ConversationsController,
    WhatsappSyncController,
    EvolutionWebhookController,
    LeadsController,
  ],
  providers: [
    PrismaService,
    TrackingService,
    EvolutionWebhookService,
    ConversationsService,
    WhatsappSyncService,
    LeadsService,
  ],
})
export class AppModule {}
