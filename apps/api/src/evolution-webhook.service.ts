import { Injectable } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Injectable()
export class EvolutionWebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async handleWebhook(payload: unknown) {
    const data = payload as any;

    const client = await this.prisma.client.upsert({
      where: { slug: "panoram-demo" },
      update: {},
      create: {
        name: "Panoram Demo",
        slug: "panoram-demo",
      },
    });

    const instanceName = this.extractInstanceName(data);
    const externalChatId = this.extractChatId(data);
    const leadPhone = this.extractLeadPhone(data);
    const messageText = this.extractMessageText(data);
    const externalMessageId = this.extractMessageId(data);
    const pushName = this.extractPushName(data);
    const fromMe = this.extractFromMe(data);
    const sentAt = this.extractSentAt(data);

    if (!leadPhone || !externalChatId) {
      return {
        status: "ignored",
        reason: "missing_lead_phone_or_chat_id",
      };
    }

    const whatsappInstance = await this.prisma.whatsAppInstance.upsert({
      where: {
        clientId_name: {
          clientId: client.id,
          name: instanceName,
        },
      },
      update: {},
      create: {
        clientId: client.id,
        name: instanceName,
      },
    });

    const lead = await this.prisma.lead.upsert({
      where: {
        clientId_phone: {
          clientId: client.id,
          phone: leadPhone,
        },
      },
      update: {
        name: pushName || undefined,
      },
      create: {
        clientId: client.id,
        name: pushName || null,
        phone: leadPhone,
        source: "whatsapp",
        firstMessage: messageText || null,
        status: "new",
      },
    });

    const conversation = await this.prisma.conversation.upsert({
      where: {
        clientId_externalChatId: {
          clientId: client.id,
          externalChatId,
        },
      },
      update: {
        leadId: lead.id,
        lastMessageAt: sentAt,
        whatsappInstanceId: whatsappInstance.id,
      },
      create: {
        clientId: client.id,
        leadId: lead.id,
        whatsappInstanceId: whatsappInstance.id,
        externalChatId,
        leadPhone,
        channel: "whatsapp",
        status: "open",
        lastMessageAt: sentAt,
      },
    });

    const existingMessage = await this.prisma.message.findUnique({
      where: {
        clientId_externalMessageId: {
          clientId: client.id,
          externalMessageId,
        },
      },
    });

    let messageCreated = false;

    if (!existingMessage) {
      await this.prisma.message.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          conversationId: conversation.id,
          externalMessageId,
          direction: fromMe ? "outbound" : "inbound",
          messageType: "text",
          body: messageText,
          fromPhone: fromMe ? null : leadPhone,
          toPhone: fromMe ? leadPhone : null,
          sentAt,
        },
      });

      messageCreated = true;
    }

    const clickCode = this.extractClickCode(messageText);
    let attributionCreated = false;
    let matchConfidence = "unknown";

    if (clickCode) {
      const clickEvent = await this.prisma.clickEvent.findUnique({
        where: { clickCode },
        include: { trackingLink: true },
      });

      if (
        clickEvent &&
        clickEvent.clientId === client.id &&
        (!clickEvent.isMatched || clickEvent.matchedLeadId === lead.id)
      ) {
        await this.prisma.clickEvent.update({
          where: { id: clickEvent.id },
          data: {
            isMatched: true,
            matchedLeadId: lead.id,
            matchedAt: new Date(),
          },
        });

        await this.prisma.leadAttribution.upsert({
          where: {
            leadId_clickEventId: {
              leadId: lead.id,
              clickEventId: clickEvent.id,
            },
          },
          update: {},
          create: {
            leadId: lead.id,
            clientId: client.id,
            trackingLinkId: clickEvent.trackingLinkId,
            clickEventId: clickEvent.id,

            sourcePlatform: clickEvent.trackingLink.sourcePlatform,
            campaignName: clickEvent.trackingLink.campaignName,
            campaignId: clickEvent.trackingLink.campaignId,
            adsetName: clickEvent.trackingLink.adsetName,
            adsetId: clickEvent.trackingLink.adsetId,
            adName: clickEvent.trackingLink.adName,
            adId: clickEvent.trackingLink.adId,

            utmSource: clickEvent.utmSource,
            utmMedium: clickEvent.utmMedium,
            utmCampaign: clickEvent.utmCampaign,
            utmContent: clickEvent.utmContent,
            utmTerm: clickEvent.utmTerm,

            gclid: clickEvent.gclid,
            gbraid: clickEvent.gbraid,
            wbraid: clickEvent.wbraid,
            fbclid: clickEvent.fbclid,
            fbc: clickEvent.fbc,
            fbp: clickEvent.fbp,

            matchMethod: "click_code",
            matchConfidence: "deterministic",
          },
        });

        attributionCreated = true;
        matchConfidence = "deterministic";
      }
    }

    return {
      status: "ok",
      leadId: lead.id,
      conversationId: conversation.id,
      messageCreated,
      clickCode,
      attributionCreated,
      matchConfidence,
    };
  }

  private extractInstanceName(payload: any): string {
    return (
      payload?.instance ||
      payload?.instanceName ||
      payload?.data?.instance ||
      "default"
    );
  }

  private extractChatId(payload: any): string | null {
    return (
      payload?.data?.key?.remoteJid ||
      payload?.key?.remoteJid ||
      payload?.remoteJid ||
      null
    );
  }

  private extractLeadPhone(payload: any): string | null {
    const chatId = this.extractChatId(payload);

    if (!chatId) return null;

    const raw = chatId.split("@")[0];

    return raw.replace(/\D/g, "") || null;
  }

  private extractMessageId(payload: any): string {
    return (
      payload?.data?.key?.id ||
      payload?.key?.id ||
      payload?.messageId ||
      `generated_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
  }

  private extractFromMe(payload: any): boolean {
    return Boolean(
      payload?.data?.key?.fromMe || payload?.key?.fromMe || payload?.fromMe,
    );
  }

  private extractPushName(payload: any): string | null {
    return (
      payload?.data?.pushName ||
      payload?.pushName ||
      payload?.contact?.name ||
      null
    );
  }

  private extractMessageText(payload: any): string | null {
    return (
      payload?.data?.message?.conversation ||
      payload?.data?.message?.extendedTextMessage?.text ||
      payload?.data?.message?.imageMessage?.caption ||
      payload?.message?.conversation ||
      payload?.message?.extendedTextMessage?.text ||
      payload?.text ||
      payload?.body ||
      null
    );
  }

  private extractSentAt(payload: any): Date {
    const timestamp =
      payload?.data?.messageTimestamp ||
      payload?.messageTimestamp ||
      payload?.timestamp;

    if (typeof timestamp === "number") {
      return new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
    }

    if (typeof timestamp === "string" && /^\d+$/.test(timestamp)) {
      const parsed = Number(timestamp);
      return new Date(parsed > 9999999999 ? parsed : parsed * 1000);
    }

    return new Date();
  }

  private extractClickCode(text: string | null): string | null {
    if (!text) return null;

    const match = text.match(/\bref\s*[:#-]?\s*([A-Fa-f0-9]{8})\b/i);

    return match?.[1]?.toUpperCase() || null;
  }
}
