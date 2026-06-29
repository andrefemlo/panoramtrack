import { Body, Controller, Param, Post } from "@nestjs/common";
import { WhatsappSyncService } from "./whatsapp-sync.service";

@Controller("whatsapp-instances")
export class WhatsappSyncController {
  constructor(private readonly whatsappSyncService: WhatsappSyncService) {}

  @Post(":instanceName/sync")
  async syncInstance(
    @Param("instanceName") instanceName: string,
    @Body() body: unknown,
  ) {
    return this.whatsappSyncService.syncInstance(
      instanceName,
      body && typeof body === "object" ? body : {},
    );
  }
}
