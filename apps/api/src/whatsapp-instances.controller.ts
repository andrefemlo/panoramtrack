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

  @Post(":instanceName/debug-media")
  async debugMedia(
    @Param("instanceName") instanceName: string,
    @Body() body: unknown,
  ) {
    return this.whatsappSyncService.debugMediaDownload(
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

  async debugMediaDownload(
    rawInstanceName: string,
    body: {
      externalMessageId?: unknown;
      remoteJid?: unknown;
    },
  ) {
    const instanceName = decodeURIComponent(rawInstanceName || "").trim();

    if (!instanceName) {
      throw new BadRequestException("instanceName is required");
    }

    const externalMessageId = this.requiredString(
      body.externalMessageId,
      "externalMessageId",
    );

    const remoteJid = this.optionalString(body.remoteJid);

    const localMessage = await this.prisma.message.findFirst({
      where: {
        externalMessageId,
      },
      include: {
        conversation: true,
      },
    });

    if (!localMessage) {
      throw new NotFoundException("Message not found in CRM database");
    }

    const finalRemoteJid =
      remoteJid || localMessage.conversation.externalChatId;

    const rawMessagesPayload = await this.fetchMessages(
      instanceName,
      finalRemoteJid,
      50,
    );

    const rawMessages = this.extractArray(rawMessagesPayload);

    const rawMessage =
      rawMessages.find((message: any) => {
        const key =
          message?.key || message?.message?.key || message?.data?.key || {};

        return (
          key?.id === externalMessageId ||
          message?.id === externalMessageId ||
          message?.messageId === externalMessageId ||
          message?.externalMessageId === externalMessageId
        );
      }) || null;

    if (!rawMessage) {
      return {
        status: "not_found_in_evolution_fetch",
        instanceName,
        externalMessageId,
        remoteJid: finalRemoteJid,
        crmMessage: {
          id: localMessage.id,
          messageType: localMessage.messageType,
          mediaMimeType: localMessage.mediaMimeType,
          mediaUrlPreview: localMessage.mediaUrl?.slice(0, 120) || null,
        },
        rawMessagesFound: rawMessages.length,
        sampleKeys: rawMessages.slice(0, 5).map((message: any) => ({
          id: message?.id,
          messageId: message?.messageId,
          keyId:
            message?.key?.id ||
            message?.message?.key?.id ||
            message?.data?.key?.id,
          messageType: message?.messageType || message?.type,
        })),
      };
    }

    const attempts = await this.debugBase64Attempts(instanceName, rawMessage);

    return {
      status: "ok",
      instanceName,
      externalMessageId,
      remoteJid: finalRemoteJid,
      crmMessage: {
        id: localMessage.id,
        messageType: localMessage.messageType,
        mediaMimeType: localMessage.mediaMimeType,
        mediaUrlPreview: localMessage.mediaUrl?.slice(0, 120) || null,
      },
      rawMessageSummary: this.summarizeRawMessage(rawMessage),
      attempts,
    };
  }
}
