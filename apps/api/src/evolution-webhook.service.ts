import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
    const instancePhone = this.extractInstancePhone(data);
    const externalChatId = this.extractChatId(data);
    const leadPhone = this.extractLeadPhone(data);
    const messageText = this.extractMessageText(data);
    const externalMessageId = this.extractMessageId(data);
    const pushName = this.extractPushName(data);
    const fromMe = this.extractFromMe(data);
    const sentAt = this.extractSentAt(data);

    await this.capturePayloadSample({
      payload: data,
      instanceName,
      externalMessageId,
      fromMe,
    });

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
      update: {
        phoneNumber: instancePhone || undefined,
      },
      create: {
        clientId: client.id,
        name: instanceName,
        phoneNumber: instancePhone || null,
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
        currentStage: "new_lead",
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
    let matchMethod = "unknown";
    let matchConfidence = "unknown";
    let matchedClickEventId: string | null = null;

    if (!fromMe) {
      if (clickCode) {
        const result = await this.matchByClickCode({
          clientId: client.id,
          leadId: lead.id,
          clickCode,
        });

        attributionCreated = result.attributionCreated;
        matchMethod = result.matchMethod;
        matchConfidence = result.matchConfidence;
        matchedClickEventId = result.matchedClickEventId;
      }

      if (!attributionCreated) {
        const result = await this.matchByTimeWindow({
          clientId: client.id,
          leadId: lead.id,
          sentAt,
          destinationWhatsappPhone: whatsappInstance.phoneNumber,
        });

        attributionCreated = result.attributionCreated;
        matchMethod = result.matchMethod;
        matchConfidence = result.matchConfidence;
        matchedClickEventId = result.matchedClickEventId;
      }
    }

    return {
      status: "ok",
      leadId: lead.id,
      conversationId: conversation.id,
      messageCreated,
      clickCode,
      attributionCreated,
      matchMethod,
      matchConfidence,
      matchedClickEventId,
    };
  }

  async listPayloadSamples(take: number) {
    const safeTake = Math.min(Math.max(take, 1), 100);

    return this.prisma.webhookPayloadSample.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: safeTake,
    });
  }

  private async matchByClickCode(params: {
    clientId: string;
    leadId: string;
    clickCode: string;
  }) {
    const clickEvent = await this.prisma.clickEvent.findUnique({
      where: { clickCode: params.clickCode },
      include: { trackingLink: true },
    });

    if (
      !clickEvent ||
      clickEvent.clientId !== params.clientId ||
      (clickEvent.isMatched && clickEvent.matchedLeadId !== params.leadId)
    ) {
      return {
        attributionCreated: false,
        matchMethod: "click_code",
        matchConfidence: "unknown",
        matchedClickEventId: null,
      };
    }

    await this.createAttributionFromClickEvent({
      clientId: params.clientId,
      leadId: params.leadId,
      clickEvent,
      matchMethod: "click_code",
      matchConfidence: "deterministic",
    });

    return {
      attributionCreated: true,
      matchMethod: "click_code",
      matchConfidence: "deterministic",
      matchedClickEventId: clickEvent.id,
    };
  }

  private async matchByTimeWindow(params: {
    clientId: string;
    leadId: string;
    sentAt: Date;
    destinationWhatsappPhone: string | null;
  }) {
    const thirtyMinutesBefore = new Date(
      params.sentAt.getTime() - 30 * 60 * 1000,
    );

    const fiveMinutesBefore = new Date(params.sentAt.getTime() - 5 * 60 * 1000);

    const destinationWhatsappPhone = params.destinationWhatsappPhone
      ? params.destinationWhatsappPhone.replace(/\D/g, "")
      : null;

    const candidates = await this.prisma.clickEvent.findMany({
      where: {
        clientId: params.clientId,
        isMatched: false,
        clickedAt: {
          gte: thirtyMinutesBefore,
          lte: params.sentAt,
        },
        ...(destinationWhatsappPhone ? { destinationWhatsappPhone } : {}),
      },
      include: {
        trackingLink: true,
      },
      orderBy: {
        clickedAt: "desc",
      },
    });

    const recentCandidates = candidates.filter(
      (candidate: { clickedAt: Date }) => {
        return candidate.clickedAt >= fiveMinutesBefore;
      },
    );

    let selectedClickEvent: any = null;
    let matchConfidence = "unknown";

    if (recentCandidates.length === 1) {
      selectedClickEvent = recentCandidates[0];
      matchConfidence = "high";
    } else if (recentCandidates.length === 0 && candidates.length === 1) {
      selectedClickEvent = candidates[0];
      matchConfidence = "medium";
    }

    if (!selectedClickEvent) {
      return {
        attributionCreated: false,
        matchMethod: "time_window",
        matchConfidence: "unknown",
        matchedClickEventId: null,
      };
    }

    await this.createAttributionFromClickEvent({
      clientId: params.clientId,
      leadId: params.leadId,
      clickEvent: selectedClickEvent,
      matchMethod: "time_window",
      matchConfidence,
    });

    return {
      attributionCreated: true,
      matchMethod: "time_window",
      matchConfidence,
      matchedClickEventId: selectedClickEvent.id,
    };
  }

  private async createAttributionFromClickEvent(params: {
    clientId: string;
    leadId: string;
    clickEvent: any;
    matchMethod: string;
    matchConfidence: string;
  }) {
    await this.prisma.clickEvent.update({
      where: { id: params.clickEvent.id },
      data: {
        isMatched: true,
        matchedLeadId: params.leadId,
        matchedAt: new Date(),
      },
    });

    await this.prisma.leadAttribution.upsert({
      where: {
        leadId_clickEventId: {
          leadId: params.leadId,
          clickEventId: params.clickEvent.id,
        },
      },
      update: {
        matchMethod: params.matchMethod,
        matchConfidence: params.matchConfidence,
      },
      create: {
        leadId: params.leadId,
        clientId: params.clientId,
        trackingLinkId: params.clickEvent.trackingLinkId,
        clickEventId: params.clickEvent.id,

        sourcePlatform: params.clickEvent.trackingLink.sourcePlatform,
        campaignName: params.clickEvent.trackingLink.campaignName,
        campaignId: params.clickEvent.trackingLink.campaignId,
        adsetName: params.clickEvent.trackingLink.adsetName,
        adsetId: params.clickEvent.trackingLink.adsetId,
        adName: params.clickEvent.trackingLink.adName,
        adId: params.clickEvent.trackingLink.adId,

        utmSource: params.clickEvent.utmSource,
        utmMedium: params.clickEvent.utmMedium,
        utmCampaign: params.clickEvent.utmCampaign,
        utmContent: params.clickEvent.utmContent,
        utmTerm: params.clickEvent.utmTerm,

        gclid: params.clickEvent.gclid,
        gbraid: params.clickEvent.gbraid,
        wbraid: params.clickEvent.wbraid,
        fbclid: params.clickEvent.fbclid,
        fbc: params.clickEvent.fbc,
        fbp: params.clickEvent.fbp,

        matchMethod: params.matchMethod,
        matchConfidence: params.matchConfidence,
      },
    });
  }

  private extractInstanceName(payload: any): string {
    return (
      payload?.instance ||
      payload?.instanceName ||
      payload?.data?.instance ||
      "default"
    );
  }

  private extractInstancePhone(payload: any): string | null {
    const value =
      payload?.instancePhone ||
      payload?.data?.instancePhone ||
      payload?.owner ||
      payload?.data?.owner ||
      payload?.sender ||
      payload?.data?.sender ||
      null;

    if (!value || typeof value !== "string") {
      return null;
    }

    const normalized = value.split("@")[0].replace(/\D/g, "");

    return normalized || null;
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

    if (!chatId) {
      return null;
    }

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
    if (!text) {
      return null;
    }

    const match = text.match(/\bref\s*[:#-]?\s*([A-Fa-f0-9]{8})\b/i);

    return match?.[1]?.toUpperCase() || null;
  }

  private async capturePayloadSample(params: {
    payload: any;
    instanceName: string;
    externalMessageId: string;
    fromMe: boolean;
  }) {
    if (process.env.EVOLUTION_WEBHOOK_CAPTURE_PAYLOADS !== "true") {
      return;
    }

    try {
      await this.prisma.webhookPayloadSample.create({
        data: {
          provider: "evolution",
          eventType: this.extractEventType(params.payload),
          instanceName: params.instanceName,
          externalMessageId: params.externalMessageId,
          fromMe: params.fromMe,
          payload: this.sanitizePayload(params.payload) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      console.warn("failed to capture evolution webhook payload sample", error);
    }
  }

  private extractEventType(payload: any): string | null {
    return (
      payload?.event ||
      payload?.type ||
      payload?.data?.event ||
      payload?.messageType ||
      payload?.data?.messageType ||
      null
    );
  }

  private sanitizePayload(value: unknown): Prisma.JsonValue {
    if (value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizePayload(item));
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === "object") {
      const sanitized: Record<string, Prisma.JsonValue> = {};

      for (const [key, childValue] of Object.entries(value)) {
        if (this.shouldRedactKey(key)) {
          sanitized[key] = "[redacted]";
          continue;
        }

        sanitized[key] = this.sanitizePayload(childValue);
      }

      return sanitized;
    }

    if (typeof value === "string") {
      return this.sanitizeString(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    return String(value);
  }

  private shouldRedactKey(key: string): boolean {
    const normalized = key.toLowerCase();

    return [
      "apikey",
      "authorization",
      "password",
      "secret",
      "token",
      "mediakey",
      "messagesecret",
      "filesha256",
      "fileencsha256",
      "jpegthumbnail",
    ].some((sensitiveKey) => normalized.includes(sensitiveKey));
  }

  private sanitizeString(value: string): string {
    const truncated =
      value.length > 1000 ? `${value.slice(0, 1000)}[truncated]` : value;

    if (truncated.includes("@s.whatsapp.net") || truncated.includes("@c.us")) {
      return truncated.replace(/\d{8,}(?=@)/g, (match) =>
        this.maskPhone(match),
      );
    }

    if (/^\d{10,15}$/.test(truncated)) {
      return this.maskPhone(truncated);
    }

    return truncated;
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 4) {
      return "[masked]";
    }

    return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
  }
}
