import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { WhatsappInstancesService } from "./whatsapp-instances.service";
import { WhatsappSyncService } from "./whatsapp-sync.service";

@Controller("whatsapp-instances")
export class WhatsappInstancesController {
  constructor(
    private readonly whatsappInstancesService: WhatsappInstancesService,
    private readonly whatsappSyncService: WhatsappSyncService,
  ) {}

  @Get()
  async listInstances(
    @Query("status") status?: string,
    @Query("search") search?: string,
  ) {
    return this.whatsappInstancesService.listInstances({
      status,
      search,
    });
  }

  @Get(":instanceName")
  async getInstance(@Param("instanceName") instanceName: string) {
    return this.whatsappInstancesService.getInstance(instanceName);
  }

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

  @Post(":instanceName/status")
  async refreshStatus(@Param("instanceName") instanceName: string) {
    return this.whatsappInstancesService.refreshInstanceStatus(instanceName);
  }

  @Post(":instanceName/reconnect")
  async reconnect(@Param("instanceName") instanceName: string) {
    return this.whatsappInstancesService.reconnectInstance(instanceName);
  }

  @Post(":instanceName/logout")
  async logout(@Param("instanceName") instanceName: string) {
    return this.whatsappInstancesService.logoutInstance(instanceName);
  }

  @Delete(":instanceName")
  async deleteInstance(@Param("instanceName") instanceName: string) {
    return this.whatsappInstancesService.deleteInstance(instanceName);
  }
}
