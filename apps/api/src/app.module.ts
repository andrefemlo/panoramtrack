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
import { WhatsappInstancesController } from "./whatsapp-instances.controller";
import { WhatsappInstancesService } from "./whatsapp-instances.service";
import { WhatsappSyncService } from "./whatsapp-sync.service";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { RealtimeEventsController } from "./realtime-events.controller";
import { RealtimeEventsService } from "./realtime-events.service";

@Module({
  controllers: [
    HealthController,
    TrackingController,
    ConversationsController,
    EvolutionWebhookController,
    RealtimeEventsController,
    LeadsController,
    WhatsappInstancesController,
    ContactsController,
  ],
  providers: [
    PrismaService,
    RealtimeEventsService,
    TrackingService,
    EvolutionWebhookService,
    ConversationsService,
    WhatsappInstancesService,
    WhatsappSyncService,
    LeadsService,
    ContactsService,
  ],
})
export class AppModule {}
