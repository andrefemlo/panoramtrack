import {
  isIndividualContactChat,
  isMessageEvent,
  normalizeEvolutionWebhook,
} from "./evolution-webhook.normalizer";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { RealtimeEventsService } from "./realtime-events.service";

@Injectable()
export class EvolutionWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeEvents: RealtimeEventsService,
  ) {}

  async handleWebhook(payload: unknown, eventFromPath?: string) {
    const data = payload as any;
    const normalized = normalizeEvolutionWebhook(payload, eventFromPath);

    const client = await this.prisma.client.upsert({
      where: { slug: "panoram-demo" },
      update: {},
      create: {
        name: "Panoram Demo",
        slug: "panoram-demo",
      },
    });

    if (!isMessageEvent(normalized.event)) {
      await this.capturePayloadSample({
        payload: data,
        instanceName: normalized.instanceName,
        externalMessageId: normalized.externalMessageId || "no_message_id",
        fromMe: normalized.fromMe,
      });

      if (this.isContactOrChatEvent(normalized.event)) {
        const result = await this.handleContactOrChatEvent({
          clientId: client.id,
          payload: data,
          event: normalized.event,
        });

        return {
          status: "ok",
          event: normalized.event,
          ...result,
        };
      }

      return {
        status: "ignored",
        reason: "event_not_handled_yet",
        event: normalized.event,
      };
    }

    const instanceName = normalized.instanceName;
    const instancePhone = normalized.instancePhone;
    const externalChatId = normalized.externalChatId;
    const leadPhone = normalized.leadPhone;
    const messageType = normalized.messageType;
    const media = {
      mediaUrl: normalized.mediaUrl,
      mediaMimeType: normalized.mediaMimeType,
      mediaFileName: normalized.mediaFileName,
    };
    const messageText = normalized.body;
    const externalMessageId =
      normalized.externalMessageId ||
      `generated_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const pushName = normalized.pushName;
    const fromMe = normalized.fromMe;
    const sentAt = normalized.sentAt;
    const whatsappLid = this.extractWhatsappLidFromPayload(data);

    if (!isIndividualContactChat(externalChatId)) {
      return {
        status: "ignored",
        reason: "non_contact_chat",
        externalChatId,
      };
    }

    if (!leadPhone || !externalChatId) {
      return {
        status: "ignored",
        reason: "missing_lead_phone_or_chat_id",
      };
    }

    await this.capturePayloadSample({
      payload: data,
      instanceName,
      externalMessageId,
      fromMe,
    });

    const whatsappInstance = await this.prisma.whatsAppInstance.upsert({
      where: {
        clientId_name: {
          clientId: client.id,
          name: instanceName,
        },
      },
      update: {
        phoneNumber: instancePhone || undefined,
        status: "active",
      },
      create: {
        clientId: client.id,
        name: instanceName,
        phoneNumber: instancePhone || null,
        status: "active",
      },
    });

    const contactName = this.getContactNameFromWebhook({
      pushName,
      fromMe,
      leadPhone,
      instancePhone,
    });

    const existingLead = await this.prisma.lead.findUnique({
      where: {
        clientId_phone: {
          clientId: client.id,
          phone: leadPhone,
        },
      },
    });

    const leadUpdateData: {
      name?: string | null;
      whatsappPushName?: string | null;
      whatsappLid?: string | null;
    } = {};

    if (whatsappLid) {
      leadUpdateData.whatsappLid = whatsappLid;
    }

    if (contactName) {
      leadUpdateData.whatsappPushName = contactName;

      if (
        existingLead &&
        this.shouldUpdateLeadName(
          existingLead.name,
          existingLead.phone,
          contactName,
        )
      ) {
        leadUpdateData.name = contactName;
      }
    }

    const lead = existingLead
      ? await this.prisma.lead.update({
          where: {
            id: existingLead.id,
          },
          data: leadUpdateData,
        })
      : await this.prisma.lead.create({
          data: {
            clientId: client.id,
            name: contactName,
            whatsappPushName: contactName,
            whatsappLid,
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

    if (!lead.profilePictureUrl || !lead.whatsappName) {
      void this.hydrateLeadProfileFromEvolution({
        instanceName,
        leadId: lead.id,
        phone: leadPhone,
        conversationId: conversation.id,
      });
    }

    const existingMessage = await this.prisma.message.findUnique({
      where: {
        clientId_externalMessageId: {
          clientId: client.id,
          externalMessageId,
        },
      },
    });

    const clickCode = this.extractClickCode(messageText);

    let messageCreated = false;

    if (!existingMessage) {
      const createdMessage = await this.prisma.message.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          conversationId: conversation.id,
          externalMessageId,
          direction: fromMe ? "outbound" : "inbound",
          messageType,
          body: messageText,
          mediaUrl: media.mediaUrl,
          mediaMimeType: media.mediaMimeType,
          mediaFileName: media.mediaFileName,
          fromPhone: fromMe ? null : leadPhone,
          toPhone: fromMe ? leadPhone : null,
          sentAt,
        },
      });

      messageCreated = true;

      this.realtimeEvents.emit({
        type: "message.created",
        conversationId: conversation.id,
        leadId: lead.id,
        messageId: createdMessage.id,
        sentAt: createdMessage.sentAt.toISOString(),
      });
    }

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

  private async hydrateLeadProfileFromEvolution(params: {
    instanceName: string;
    leadId: string;
    phone: string;
    conversationId?: string | null;
  }) {
    const profilePictureUrl = await this.fetchProfilePictureUrlFromEvolution({
      instanceName: params.instanceName,
      phone: params.phone,
    });

    const whatsappName = await this.fetchWhatsappNameFromEvolution({
      instanceName: params.instanceName,
      phone: params.phone,
    });

    const existingLead = await this.prisma.lead.findUnique({
      where: {
        id: params.leadId,
      },
    });

    if (!existingLead) {
      return;
    }

    const data: {
      profilePictureUrl?: string;
      whatsappName?: string;
    } = {};

    if (
      profilePictureUrl &&
      profilePictureUrl !== existingLead.profilePictureUrl
    ) {
      data.profilePictureUrl = profilePictureUrl;
    }

    if (whatsappName && whatsappName !== existingLead.whatsappName) {
      data.whatsappName = whatsappName;
    }

    if (!Object.keys(data).length) {
      return;
    }

    await this.prisma.lead.update({
      where: {
        id: params.leadId,
      },
      data,
    });

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        leadId: params.leadId,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
      select: {
        id: true,
      },
    });

    this.realtimeEvents.emit({
      type: "contact.updated",
      conversationId: params.conversationId || conversation?.id || null,
      leadId: params.leadId,
      sentAt: new Date().toISOString(),
    });
  }

  private async fetchProfilePictureUrlFromEvolution(params: {
    instanceName: string;
    phone: string;
  }): Promise<string | null> {
    const baseUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!baseUrl || !apiKey) {
      return null;
    }

    const encodedInstance = encodeURIComponent(params.instanceName);
    const remoteJid = `${params.phone}@s.whatsapp.net`;

    const attempts = [
      {
        path: `/chat/fetchProfilePictureUrl/${encodedInstance}`,
        body: {
          number: params.phone,
        },
      },
      {
        path: `/chat/fetchProfilePictureUrl/${encodedInstance}`,
        body: {
          remoteJid,
        },
      },
      {
        path: `/chat/fetchProfilePictureUrl/${encodedInstance}`,
        body: {
          contact: remoteJid,
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const response = await fetch(`${baseUrl}${attempt.path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: apiKey,
          },
          body: JSON.stringify(attempt.body),
        });

        if (!response.ok) {
          continue;
        }

        const result = await response.json();
        const profilePictureUrl = this.extractProfilePictureUrl(result);

        if (profilePictureUrl) {
          return profilePictureUrl;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async fetchWhatsappNameFromEvolution(params: {
    instanceName: string;
    phone: string;
  }): Promise<string | null> {
    const baseUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!baseUrl || !apiKey) {
      return null;
    }

    const encodedInstance = encodeURIComponent(params.instanceName);
    const remoteJid = `${params.phone}@s.whatsapp.net`;

    const attempts = [
      {
        path: `/chat/findContacts/${encodedInstance}`,
        body: {
          where: {
            remoteJid,
          },
        },
      },
      {
        path: `/chat/findContacts/${encodedInstance}`,
        body: {
          where: {
            id: remoteJid,
          },
        },
      },
      {
        path: `/chat/findChats/${encodedInstance}`,
        body: {
          where: {
            remoteJid,
          },
        },
      },
      {
        path: `/chat/findChats/${encodedInstance}`,
        body: {
          where: {
            id: remoteJid,
          },
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const response = await fetch(`${baseUrl}${attempt.path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: apiKey,
          },
          body: JSON.stringify(attempt.body),
        });

        if (!response.ok) {
          continue;
        }

        const result = await response.json();
        const items = this.extractContactEventItems(result);

        const matched =
          items.find((item) => {
            const itemJid =
              item?.remoteJid ||
              item?.id ||
              item?.jid ||
              item?.key?.remoteJid ||
              item?.chatId;

            return itemJid === remoteJid;
          }) || items[0];

        const name = this.cleanContactName(
          matched?.name ||
            matched?.pushName ||
            matched?.verifiedName ||
            matched?.notify ||
            matched?.subject,
        );

        if (name) {
          return name;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private extractProfilePictureUrl(value: any): string | null {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.extractProfilePictureUrl(item);

        if (result) {
          return result;
        }
      }

      return null;
    }

    const direct = this.optionalString(
      value?.profilePictureUrl ||
        value?.profilePicUrl ||
        value?.pictureUrl ||
        value?.picture ||
        value?.url ||
        value?.avatar ||
        value?.imgUrl ||
        value?.image ||
        value?.data?.profilePictureUrl ||
        value?.data?.profilePicUrl ||
        value?.data?.pictureUrl ||
        value?.data?.picture ||
        value?.data?.url,
    );

    if (direct) {
      return direct;
    }

    if (value?.data) {
      return this.extractProfilePictureUrl(value.data);
    }

    if (value?.contact) {
      return this.extractProfilePictureUrl(value.contact);
    }

    return null;
  }

  private extractProfileName(value: any): string | null {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.extractProfileName(item);

        if (result) {
          return result;
        }
      }

      return null;
    }

    const name = this.cleanContactName(
      value?.name ||
        value?.pushName ||
        value?.verifiedName ||
        value?.notify ||
        value?.displayName ||
        value?.contactName ||
        value?.profileName ||
        value?.data?.name ||
        value?.data?.pushName ||
        value?.data?.verifiedName ||
        value?.data?.notify ||
        value?.contact?.name ||
        value?.contact?.pushName,
    );

    if (name) {
      return name;
    }

    if (value?.data) {
      return this.extractProfileName(value.data);
    }

    if (value?.contact) {
      return this.extractProfileName(value.contact);
    }

    return null;
  }

  private isContactOrChatEvent(event: string | null): boolean {
    const normalized = String(event || "").toLowerCase();

    return [
      "contacts.update",
      "contacts.upsert",
      "contacts.set",
      "chats.update",
      "chats.upsert",
      "chats.set",
    ].includes(normalized);
  }

  private async handleContactOrChatEvent(params: {
    clientId: string;
    payload: any;
    event: string | null;
  }) {
    const items = this.extractContactEventItems(params.payload);

    let processed = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of items) {
      const remoteJid = this.optionalString(
        item?.remoteJid ||
          item?.id ||
          item?.jid ||
          item?.key?.remoteJid ||
          item?.chatId,
      );

      if (!remoteJid) {
        skipped += 1;
        continue;
      }

      if (!this.isIndividualPhoneJid(remoteJid) && !this.isLidJid(remoteJid)) {
        skipped += 1;
        continue;
      }

      const phone = this.isIndividualPhoneJid(remoteJid)
        ? this.phoneFromRemoteJid(remoteJid)
        : null;

      const whatsappLid = this.isLidJid(remoteJid) ? remoteJid : null;

      const whatsappName = this.cleanContactName(
        item?.name ||
          item?.pushName ||
          item?.verifiedName ||
          item?.notify ||
          item?.subject ||
          item?.displayName ||
          item?.contactName ||
          item?.profileName,
      );

      const profilePictureUrl = this.optionalString(
        item?.profilePicUrl ||
          item?.profilePictureUrl ||
          item?.pictureUrl ||
          item?.picture ||
          item?.profilePicture ||
          item?.avatar ||
          item?.imgUrl ||
          item?.image,
      );

      const existingLead = await this.findLeadByPhoneOrLid({
        clientId: params.clientId,
        phone,
        whatsappLid,
      });

      if (!existingLead) {
        skipped += 1;
        continue;
      }

      const data: {
        whatsappName?: string | null;
        profilePictureUrl?: string | null;
        whatsappLid?: string | null;
      } = {};

      if (whatsappName && whatsappName !== existingLead.whatsappName) {
        data.whatsappName = whatsappName;
      }

      if (
        profilePictureUrl !== null &&
        profilePictureUrl !== existingLead.profilePictureUrl
      ) {
        data.profilePictureUrl = profilePictureUrl;
      }

      if (whatsappLid && whatsappLid !== existingLead.whatsappLid) {
        data.whatsappLid = whatsappLid;
      }

      if (!Object.keys(data).length) {
        processed += 1;
        continue;
      }

      await this.prisma.lead.update({
        where: {
          id: existingLead.id,
        },
        data,
      });

      const conversationId = await this.findConversationIdByLeadId(
        existingLead.id,
      );

      this.realtimeEvents.emit({
        type: "contact.updated",
        conversationId,
        leadId: existingLead.id,
        sentAt: new Date().toISOString(),
      });

      processed += 1;
      updated += 1;
    }

    return {
      processed,
      updated,
      skipped,
    };
  }

  private async findLeadByPhoneOrLid(params: {
    clientId: string;
    phone?: string | null;
    whatsappLid?: string | null;
  }) {
    const or: Prisma.LeadWhereInput[] = [];

    if (params.phone) {
      or.push({
        phone: params.phone,
      });
    }

    if (params.whatsappLid) {
      or.push({
        whatsappLid: params.whatsappLid,
      });
    }

    if (!or.length) {
      return null;
    }

    return this.prisma.lead.findFirst({
      where: {
        clientId: params.clientId,
        OR: or,
      },
    });
  }

  private extractContactEventItems(payload: any): any[] {
    const data = payload?.data;

    if (Array.isArray(data)) {
      return data;
    }

    if (data && typeof data === "object") {
      return [data];
    }

    if (Array.isArray(payload?.contacts)) {
      return payload.contacts;
    }

    if (Array.isArray(payload?.chats)) {
      return payload.chats;
    }

    return [];
  }

  private phoneFromRemoteJid(remoteJid: string | null): string | null {
    if (!remoteJid) {
      return null;
    }

    const raw = remoteJid.split("@")[0];
    const phone = raw.replace(/\D/g, "");

    return phone || null;
  }

  private cleanContactName(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const name = value.trim();

    if (!name) {
      return null;
    }

    const lowered = name.toLowerCase();

    if (
      lowered.includes("@s.whatsapp.net") ||
      lowered.includes("@g.us") ||
      lowered.includes("@newsletter") ||
      lowered === "status" ||
      lowered.startsWith("meu numero") ||
      lowered.startsWith("meu número")
    ) {
      return null;
    }

    if (/^\+?\d{8,15}$/.test(name.replace(/\s+/g, ""))) {
      return null;
    }

    return name;
  }

  private async findConversationIdByLeadId(
    leadId: string,
  ): Promise<string | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        leadId,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
      orderBy: {
        lastMessageAt: "desc",
      },
      select: {
        id: true,
      },
    });

    return conversation?.id || null;
  }

  private extractWhatsappLidFromPayload(payload: any): string | null {
    const candidates = [
      payload?.data?.key?.remoteJid,
      payload?.data?.key?.remoteJidAlt,
      payload?.data?.key?.participant,
      payload?.data?.key?.participantAlt,
      payload?.data?.remoteJid,
      payload?.data?.remoteJidAlt,
    ];

    const lid = candidates.find(
      (value) => typeof value === "string" && value.endsWith("@lid"),
    );

    return lid || null;
  }

  private isLidJid(remoteJid: string | null): boolean {
    return !!remoteJid && remoteJid.toLowerCase().endsWith("@lid");
  }

  private isIndividualPhoneJid(remoteJid: string | null): boolean {
    return !!remoteJid && remoteJid.toLowerCase().endsWith("@s.whatsapp.net");
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
          payload: this.sanitizePayload(
            params.payload,
          ) as Prisma.InputJsonValue,
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

  private getContactNameFromWebhook(params: {
    pushName: string | null;
    fromMe: boolean;
    leadPhone: string;
    instancePhone: string | null;
  }): string | null {
    const pushName = params.pushName?.trim();

    if (!pushName) {
      return null;
    }

    if (params.fromMe) {
      return null;
    }

    const normalizedPushName = pushName.replace(/\D/g, "");
    const normalizedLeadPhone = params.leadPhone.replace(/\D/g, "");
    const normalizedInstancePhone =
      params.instancePhone?.replace(/\D/g, "") || "";

    if (normalizedPushName && normalizedPushName === normalizedLeadPhone) {
      return null;
    }

    if (
      normalizedInstancePhone &&
      normalizedPushName === normalizedInstancePhone
    ) {
      return null;
    }

    return pushName;
  }

  private optionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();

    return trimmed || null;
  }

  private shouldUpdateLeadName(
    currentName: string | null,
    leadPhone: string,
    incomingName: string,
  ): boolean {
    const current = currentName?.trim();
    const incoming = incomingName.trim();

    if (!incoming) {
      return false;
    }

    const normalizedIncoming = incoming.replace(/\D/g, "");
    const normalizedPhone = leadPhone.replace(/\D/g, "");
    const normalizedCurrent = current?.replace(/\D/g, "") || "";

    if (normalizedIncoming && normalizedIncoming === normalizedPhone) {
      return false;
    }

    if (incoming.includes("@s.whatsapp.net")) {
      return false;
    }

    if (/^\+?\d{8,15}$/.test(incoming.replace(/\s/g, ""))) {
      return false;
    }

    if (!current) {
      return true;
    }

    if (normalizedCurrent && normalizedCurrent === normalizedPhone) {
      return true;
    }

    if (/^\+?\d{8,15}$/.test(current.replace(/\s/g, ""))) {
      return true;
    }

    return false;
  }
}
