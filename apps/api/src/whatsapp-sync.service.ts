import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "./prisma.service";

type InstanceStatus = "active" | "inactive" | "deleted";

@Injectable()
export class WhatsappSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async syncInstance(
    rawInstanceName: string,
    body: {
      messagesPerChat?: unknown;
    },
  ) {
    const instanceName = decodeURIComponent(rawInstanceName || "").trim();

    if (!instanceName) {
      throw new BadRequestException("instanceName is required");
    }

    const messagesPerChat = this.clampNumber(body.messagesPerChat, 30, 0, 100);
    const client = await this.getDemoClient();
    const instanceStatus = await this.getEvolutionInstanceStatus(instanceName);

    if (instanceStatus === "deleted") {
      await this.prisma.whatsAppInstance.updateMany({
        where: {
          clientId: client.id,
          name: instanceName,
        },
        data: {
          status: "deleted",
        },
      });

      return {
        status: "deleted",
        instanceName,
        synced: false,
        reason: "instance_not_found_in_evolution",
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
        status: instanceStatus || "active",
      },
      create: {
        clientId: client.id,
        name: instanceName,
        status: instanceStatus || "active",
      },
    });

    const chatsPayload = await this.fetchChatsOrContacts(instanceName);
    const rawChats = this.extractArray(chatsPayload);

    const summary = {
      status: "ok",
      instanceName,
      instanceStatus: instanceStatus || "unknown",
      chatsFound: rawChats.length,
      individualChatsSynced: 0,
      leadsCreated: 0,
      leadsUpdated: 0,
      conversationsCreated: 0,
      conversationsUpdated: 0,
      messagesFound: 0,
      messagesCreated: 0,
      messagesSkipped: 0,
      messageSyncErrors: 0,
    };

    for (const rawChat of rawChats) {
      const chat = this.normalizeChat(rawChat);

      if (
        !chat.externalChatId ||
        !this.isIndividualContactChat(chat.externalChatId)
      ) {
        continue;
      }

      const leadPhone = this.phoneFromChatId(chat.externalChatId);

      if (!leadPhone) {
        continue;
      }

      const existingLead = await this.prisma.lead.findUnique({
        where: {
          clientId_phone: {
            clientId: client.id,
            phone: leadPhone,
          },
        },
      });

      const leadData: {
        whatsappName?: string | null;
      } = {};

      if (chat.contactName && chat.contactName !== existingLead?.whatsappName) {
        leadData.whatsappName = chat.contactName;
      }

      const lead = existingLead
        ? Object.keys(leadData).length
          ? await this.prisma.lead.update({
              where: {
                id: existingLead.id,
              },
              data: leadData,
            })
          : existingLead
        : await this.prisma.lead.create({
            data: {
              clientId: client.id,
              name: null,
              whatsappName: chat.contactName,
              phone: leadPhone,
              source: "whatsapp",
              firstMessage: null,
              status: "new",
              currentStage: "new_lead",
            },
          });

      if (existingLead) {
        summary.leadsUpdated += Object.keys(leadData).length ? 1 : 0;
      } else {
        summary.leadsCreated += 1;
      }
      const existingConversation = await this.prisma.conversation.findUnique({
        where: {
          clientId_externalChatId: {
            clientId: client.id,
            externalChatId: chat.externalChatId,
          },
        },
      });

      const conversation = await this.prisma.conversation.upsert({
        where: {
          clientId_externalChatId: {
            clientId: client.id,
            externalChatId: chat.externalChatId,
          },
        },
        update: {
          leadId: lead.id,
          whatsappInstanceId: whatsappInstance.id,
          leadPhone,
          lastMessageAt:
            chat.lastMessageAt || existingConversation?.lastMessageAt,
          status: "open",
        },
        create: {
          clientId: client.id,
          leadId: lead.id,
          whatsappInstanceId: whatsappInstance.id,
          externalChatId: chat.externalChatId,
          leadPhone,
          channel: "whatsapp",
          status: "open",
          lastMessageAt: chat.lastMessageAt,
        },
      });

      if (existingConversation) {
        summary.conversationsUpdated += 1;
      } else {
        summary.conversationsCreated += 1;
      }

      summary.individualChatsSynced += 1;

      if (messagesPerChat > 0) {
        try {
          const result = await this.syncMessagesForChat({
            instanceName,
            clientId: client.id,
            leadId: lead.id,
            conversationId: conversation.id,
            externalChatId: chat.externalChatId,
            leadPhone,
            messagesPerChat,
          });

          summary.messagesFound += result.messagesFound;
          summary.messagesCreated += result.messagesCreated;
          summary.messagesSkipped += result.messagesSkipped;
        } catch {
          summary.messageSyncErrors += 1;
        }
      }
    }

    return summary;
  }

  async syncContacts(rawInstanceName: string) {
    const instanceName = decodeURIComponent(rawInstanceName || "").trim();

    if (!instanceName) {
      throw new BadRequestException("instanceName is required");
    }

    const client = await this.getDemoClient();

    const contactsPayload = await this.fetchContacts(instanceName);
    const rawContacts = this.extractArray(contactsPayload);

    const summary = {
      status: "ok",
      instanceName,
      contactsFound: rawContacts.length,
      contactsWithPhone: 0,
      existingLeadsFound: 0,
      leadsUpdatedName: 0,
      leadsUpdatedPhoto: 0,
      leadsSkipped: 0,
      sample: [] as Array<{
        phone: string;
        oldName: string | null;
        newName: string | null;
        hasPhoto: boolean;
      }>,
    };

    for (const rawContact of rawContacts) {
      const contact = this.normalizeContact(rawContact);

      if (!contact.phone) {
        summary.leadsSkipped += 1;
        continue;
      }

      summary.contactsWithPhone += 1;

      const existingLead = await this.prisma.lead.findUnique({
        where: {
          clientId_phone: {
            clientId: client.id,
            phone: contact.phone,
          },
        },
      });

      if (!existingLead) {
        summary.leadsSkipped += 1;
        continue;
      }

      summary.existingLeadsFound += 1;

      const data: {
        whatsappName?: string;
        profilePictureUrl?: string;
      } = {};

      if (contact.name && contact.name !== existingLead.whatsappName) {
        data.whatsappName = contact.name;
      }

      if (
        contact.profilePictureUrl &&
        contact.profilePictureUrl !== existingLead.profilePictureUrl
      ) {
        data.profilePictureUrl = contact.profilePictureUrl;
      }

      if (!Object.keys(data).length) {
        summary.leadsSkipped += 1;
        continue;
      }

      await this.prisma.lead.update({
        where: {
          id: existingLead.id,
        },
        data,
      });

      if (data.whatsappName) {
        summary.leadsUpdatedName += 1;
      }

      if (data.profilePictureUrl) {
        summary.leadsUpdatedPhoto += 1;
      }

      if (summary.sample.length < 20) {
        summary.sample.push({
          phone: contact.phone,
          oldName: existingLead.name,
          newName: data.whatsappName || contact.name,
          hasPhoto: !!data.profilePictureUrl,
        });
      }
    }

    return summary;
  }

  private async syncMessagesForChat(params: {
    instanceName: string;
    clientId: string;
    leadId: string;
    conversationId: string;
    externalChatId: string;
    leadPhone: string;
    messagesPerChat: number;
  }) {
    const messagesPayload = await this.fetchMessages(
      params.instanceName,
      params.externalChatId,
      params.messagesPerChat,
    );

    const rawMessages = this.extractArray(messagesPayload);

    let messagesCreated = 0;
    let messagesUpdated = 0;
    let messagesSkipped = 0;
    let lastMessageAt: Date | null = null;

    for (const rawMessage of rawMessages) {
      const message = this.normalizeMessage(rawMessage, params.externalChatId);

      await this.hydrateMessageMedia({
        instanceName: params.instanceName,
        rawMessage,
        message,
      });

      if (!message.externalMessageId) {
        messagesSkipped += 1;
        continue;
      }

      const existing = await this.prisma.message.findUnique({
        where: {
          clientId_externalMessageId: {
            clientId: params.clientId,
            externalMessageId: message.externalMessageId,
          },
        },
      });

      if (existing) {
        const shouldUpdateMedia =
          !!message.mediaUrl &&
          (!existing.mediaUrl ||
            existing.mediaUrl.startsWith("http") ||
            existing.mediaUrl.includes("mmg.whatsapp.net") ||
            existing.mediaUrl.endsWith(".enc"));

        const shouldUpdateType =
          existing.messageType === "text" &&
          ["image", "audio", "video", "document", "sticker"].includes(
            message.messageType,
          );

        const shouldUpdateBody = !existing.body && !!message.body;

        if (shouldUpdateMedia || shouldUpdateType || shouldUpdateBody) {
          const updated = await this.prisma.message.update({
            where: {
              id: existing.id,
            },
            data: {
              messageType: shouldUpdateType
                ? message.messageType
                : existing.messageType,
              body: shouldUpdateBody ? message.body : existing.body,
              mediaUrl: shouldUpdateMedia
                ? message.mediaUrl
                : existing.mediaUrl,
              mediaMimeType: shouldUpdateMedia
                ? message.mediaMimeType
                : existing.mediaMimeType,
              mediaFileName: shouldUpdateMedia
                ? message.mediaFileName
                : existing.mediaFileName,
            },
          });

          messagesUpdated += 1;

          if (!lastMessageAt || updated.sentAt > lastMessageAt) {
            lastMessageAt = updated.sentAt;
          }
        } else {
          messagesSkipped += 1;

          if (!lastMessageAt || existing.sentAt > lastMessageAt) {
            lastMessageAt = existing.sentAt;
          }
        }

        continue;
      }

      const created = await this.prisma.message.create({
        data: {
          clientId: params.clientId,
          leadId: params.leadId,
          conversationId: params.conversationId,
          externalMessageId: message.externalMessageId,
          direction: message.fromMe ? "outbound" : "inbound",
          messageType: message.messageType,
          body: message.body,
          mediaUrl: message.mediaUrl,
          mediaMimeType: message.mediaMimeType,
          mediaFileName: message.mediaFileName,
          fromPhone: message.fromMe ? null : params.leadPhone,
          toPhone: message.fromMe ? params.leadPhone : null,
          sentAt: message.sentAt,
        },
      });

      messagesCreated += 1;

      if (!lastMessageAt || created.sentAt > lastMessageAt) {
        lastMessageAt = created.sentAt;
      }
    }

    if (lastMessageAt) {
      await this.prisma.conversation.update({
        where: {
          id: params.conversationId,
        },
        data: {
          lastMessageAt,
        },
      });
    }

    return {
      messagesFound: rawMessages.length,
      messagesCreated,
      messagesUpdated,
      messagesSkipped,
    };
  }

  private async fetchChatsOrContacts(instanceName: string) {
    const attempts = [
      {
        path: `/chat/findChats/${encodeURIComponent(instanceName)}`,
        body: {},
      },
      {
        path: `/chat/findContacts/${encodeURIComponent(instanceName)}`,
        body: {},
      },
    ];

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        const result = await this.callEvolution(
          "POST",
          attempt.path,
          attempt.body,
        );
        const array = this.extractArray(result);

        if (array.length) {
          return result;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  private async fetchContacts(instanceName: string) {
    const encodedInstanceName = encodeURIComponent(instanceName);

    const attempts = [
      {
        path: `/chat/findContacts/${encodedInstanceName}`,
        body: {},
      },
      {
        path: `/chat/findContacts/${encodedInstanceName}`,
        body: {
          where: {},
        },
      },
      {
        path: `/chat/findChats/${encodedInstanceName}`,
        body: {},
      },
    ];

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        const result = await this.callEvolution(
          "POST",
          attempt.path,
          attempt.body,
        );

        const array = this.extractArray(result);

        if (array.length) {
          return result;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  private async fetchMessages(
    instanceName: string,
    remoteJid: string,
    limit: number,
  ) {
    const encodedInstanceName = encodeURIComponent(instanceName);

    const attempts = [
      {
        path: `/chat/findMessages/${encodedInstanceName}`,
        body: {
          where: {
            key: {
              remoteJid,
            },
          },
          limit,
        },
      },
      {
        path: `/chat/findMessages/${encodedInstanceName}`,
        body: {
          where: {
            remoteJid,
          },
          limit,
        },
      },
      {
        path: `/chat/findMessages/${encodedInstanceName}`,
        body: {
          remoteJid,
          limit,
        },
      },
    ];

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        return await this.callEvolution("POST", attempt.path, attempt.body);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new BadRequestException("Unable to fetch messages");
  }

  private async getEvolutionInstanceStatus(
    instanceName: string,
  ): Promise<InstanceStatus | null> {
    try {
      const result = await this.callEvolution(
        "GET",
        `/instance/connectionState/${encodeURIComponent(instanceName)}`,
      );

      const state = this.extractEvolutionConnectionState(result);

      if (!state) {
        return null;
      }

      const normalized = state.toLowerCase();

      if (["open", "connected", "online", "active"].includes(normalized)) {
        return "active";
      }

      if (
        [
          "close",
          "closed",
          "disconnected",
          "offline",
          "connecting",
          "qrcode",
          "qr",
          "pairing",
          "inactive",
        ].includes(normalized)
      ) {
        return "inactive";
      }

      return "inactive";
    } catch (error: any) {
      if (error?.status === 404) {
        return "deleted";
      }

      return null;
    }
  }

  private async callEvolution(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ) {
    const baseUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!baseUrl || !apiKey) {
      throw new BadRequestException("Evolution API env vars are missing");
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    });

    const text = await response.text();

    let data: unknown = text;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const error: any = new BadRequestException({
        message: "Evolution API request failed",
        status: response.status,
        path,
        response: data,
      });

      error.status = response.status;

      throw error;
    }

    return data;
  }

  private normalizeContact(rawContact: unknown) {
    const contact = rawContact as any;

    const jid = this.optionalString(
      contact?.remoteJid ||
        contact?.id ||
        contact?.jid ||
        contact?.chatId ||
        contact?.key?.remoteJid ||
        contact?.waId ||
        contact?.number ||
        contact?.phone ||
        contact?.contact?.id ||
        contact?.contact?.jid,
    );

    const phone =
      this.phoneFromContactValue(jid) ||
      this.phoneFromContactValue(contact?.number) ||
      this.phoneFromContactValue(contact?.phone) ||
      this.phoneFromContactValue(contact?.waId) ||
      null;

    const name = this.cleanContactName(
      contact?.name ||
        contact?.pushName ||
        contact?.notify ||
        contact?.verifiedName ||
        contact?.contactName ||
        contact?.profileName ||
        contact?.shortName ||
        contact?.displayName ||
        contact?.contact?.name ||
        contact?.contact?.pushName ||
        contact?.contact?.notify,
      phone ? `${phone}@s.whatsapp.net` : jid,
    );

    const profilePictureUrl =
      this.optionalString(
        contact?.profilePictureUrl ||
          contact?.profilePicUrl ||
          contact?.pictureUrl ||
          contact?.profilePicture ||
          contact?.avatar ||
          contact?.imgUrl ||
          contact?.image ||
          contact?.contact?.profilePictureUrl ||
          contact?.contact?.profilePicUrl,
      ) || null;

    return {
      jid,
      phone,
      name,
      profilePictureUrl,
    };
  }

  private normalizeChat(rawChat: unknown) {
    const chat = rawChat as any;

    const externalChatId = this.optionalString(
      chat?.remoteJid ||
        chat?.id ||
        chat?.jid ||
        chat?.chatId ||
        chat?.key?.remoteJid ||
        chat?.conversationId,
    );

    const contactName = this.cleanContactName(
      chat?.name ||
        chat?.pushName ||
        chat?.notify ||
        chat?.verifiedName ||
        chat?.contactName ||
        chat?.profileName ||
        chat?.shortName,
      externalChatId,
    );

    const lastMessageAt =
      this.dateFromUnknown(
        chat?.lastMessage?.messageTimestamp ||
          chat?.lastMessageAt ||
          chat?.conversationTimestamp ||
          chat?.updatedAt ||
          chat?.createdAt,
      ) || null;

    return {
      externalChatId,
      contactName,
      lastMessageAt,
    };
  }

  private normalizeMessage(rawMessage: unknown, fallbackRemoteJid: string) {
    const item = rawMessage as any;
    const key = item?.key || item?.message?.key || {};

    const messageNode =
      item?.message?.message ||
      item?.message ||
      item?.data?.message ||
      item?.content ||
      {};

    const remoteJid =
      this.optionalString(key?.remoteJid || item?.remoteJid || item?.chatId) ||
      fallbackRemoteJid;

    const externalMessageId =
      this.optionalString(
        key?.id ||
          item?.id ||
          item?.messageId ||
          item?.externalMessageId ||
          item?.data?.key?.id,
      ) || this.syntheticMessageId(remoteJid, item);

    const fromMe = Boolean(
      key?.fromMe ?? item?.fromMe ?? item?.data?.key?.fromMe ?? false,
    );

    const messageType = this.extractMessageType(messageNode, item);
    const media = this.extractMediaFields(messageNode, item, messageType);

    const body =
      this.optionalString(
        messageNode?.conversation ||
          messageNode?.extendedTextMessage?.text ||
          messageNode?.imageMessage?.caption ||
          messageNode?.videoMessage?.caption ||
          item?.text ||
          item?.body ||
          item?.caption,
      ) || null;

    const sentAt =
      this.dateFromUnknown(
        item?.messageTimestamp ||
          item?.timestamp ||
          item?.createdAt ||
          item?.data?.messageTimestamp,
      ) || new Date();

    return {
      externalMessageId,
      fromMe,
      messageType,
      body,
      sentAt,
      mediaUrl: media.mediaUrl,
      mediaMimeType: media.mediaMimeType,
      mediaFileName: media.mediaFileName,
    };
  }

  private extractMessageType(messageNode: any, item: any): string {
    const explicit = this.optionalString(item?.messageType || item?.type);

    if (explicit) {
      const normalized = explicit.toLowerCase();

      if (normalized.includes("image")) return "image";
      if (normalized.includes("audio")) return "audio";
      if (normalized.includes("video")) return "video";
      if (normalized.includes("document")) return "document";
      if (normalized.includes("sticker")) return "sticker";

      return normalized;
    }

    if (messageNode?.imageMessage) return "image";
    if (messageNode?.audioMessage) return "audio";
    if (messageNode?.videoMessage) return "video";
    if (messageNode?.documentMessage) return "document";
    if (messageNode?.stickerMessage) return "sticker";

    return "text";
  }

  private extractMediaFields(messageNode: any, item: any, messageType: string) {
    const node =
      messageType === "image"
        ? messageNode?.imageMessage
        : messageType === "audio"
          ? messageNode?.audioMessage
          : messageType === "video"
            ? messageNode?.videoMessage
            : messageType === "document"
              ? messageNode?.documentMessage
              : messageType === "sticker"
                ? messageNode?.stickerMessage
                : null;

    return {
      mediaUrl:
        this.optionalString(node?.url || item?.mediaUrl || item?.url) || null,
      mediaMimeType:
        this.optionalString(
          node?.mimetype || item?.mimetype || item?.mimeType,
        ) || null,
      mediaFileName:
        this.optionalString(
          item?.fileName ||
            item?.filename ||
            node?.fileName ||
            node?.fileNameWithExtension,
        ) || null,
    };
  }

  private extractArray(value: unknown): any[] {
    if (Array.isArray(value)) {
      return value;
    }

    const data = value as any;

    const candidates = [
      data?.data,
      data?.response,
      data?.result,

      data?.chats,
      data?.contacts,
      data?.messages,
      data?.records,
      data?.rows,

      data?.data?.chats,
      data?.data?.contacts,
      data?.data?.messages,
      data?.data?.records,
      data?.data?.rows,

      data?.response?.chats,
      data?.response?.contacts,
      data?.response?.messages,
      data?.response?.records,
      data?.response?.rows,

      data?.result?.chats,
      data?.result?.contacts,
      data?.result?.messages,
      data?.result?.records,
      data?.result?.rows,

      data?.messages?.records,
      data?.messages?.rows,
      data?.messages?.data,

      data?.data?.messages?.records,
      data?.data?.messages?.rows,
      data?.data?.messages?.data,

      data?.response?.messages?.records,
      data?.response?.messages?.rows,
      data?.response?.messages?.data,

      data?.result?.messages?.records,
      data?.result?.messages?.rows,
      data?.result?.messages?.data,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }

    return [];
  }

  private extractEvolutionConnectionState(data: unknown): string | null {
    if (!data || typeof data !== "object") {
      return typeof data === "string" ? data : null;
    }

    const value = data as any;

    const state =
      value.state ||
      value.status ||
      value.connectionStatus ||
      value.instance?.state ||
      value.instance?.status ||
      value.instance?.connectionStatus ||
      value.data?.state ||
      value.data?.status ||
      value.data?.connectionStatus;

    return typeof state === "string" && state.trim() ? state.trim() : null;
  }

  private isIndividualContactChat(chatId: string | null): boolean {
    if (!chatId) {
      return false;
    }

    const normalized = chatId.toLowerCase();

    if (normalized === "status@broadcast") {
      return false;
    }

    if (normalized.endsWith("@g.us")) {
      return false;
    }

    if (normalized.endsWith("@newsletter")) {
      return false;
    }

    if (normalized.endsWith("@broadcast")) {
      return false;
    }

    return normalized.endsWith("@s.whatsapp.net");
  }

  private phoneFromContactValue(value: unknown): string | null {
    const text = this.optionalString(value);

    if (!text) {
      return null;
    }

    if (
      text.includes("@g.us") ||
      text.includes("@newsletter") ||
      text.includes("@broadcast") ||
      text === "status@broadcast"
    ) {
      return null;
    }

    const leftSide = text.includes("@") ? text.split("@")[0] : text;
    const digits = leftSide.replace(/\D/g, "");

    if (digits.length < 8) {
      return null;
    }

    return digits;
  }

  private phoneFromChatId(chatId: string): string | null {
    const phone = chatId.split("@")[0]?.replace(/\D/g, "") || "";

    if (phone.length < 8) {
      return null;
    }

    return phone;
  }

  private cleanContactName(
    value: unknown,
    externalChatId: string | null,
  ): string | null {
    const text = this.optionalString(value);

    if (!text) {
      return null;
    }

    if (
      text.includes("@s.whatsapp.net") ||
      text.includes("@g.us") ||
      text.includes("@newsletter")
    ) {
      return null;
    }

    if (text.toLowerCase() === "status") {
      return null;
    }

    const chatPhone = externalChatId
      ? this.phoneFromContactValue(externalChatId)
      : null;

    const textDigits = text.replace(/\D/g, "");

    if (chatPhone && textDigits && textDigits === chatPhone) {
      return null;
    }

    if (/^\+?\d{8,15}$/.test(text.replace(/\s/g, ""))) {
      return null;
    }

    return text;
  }

  private dateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === "object") {
      const objectValue = value as any;

      if (typeof objectValue.low === "number") {
        return this.dateFromUnknown(objectValue.low);
      }
    }

    if (typeof value === "number") {
      const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
      const date = new Date(milliseconds);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === "string") {
      const numeric = Number(value);

      if (!Number.isNaN(numeric) && value.trim()) {
        return this.dateFromUnknown(numeric);
      }

      const date = new Date(value);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  private syntheticMessageId(remoteJid: string, item: any): string {
    const timestamp =
      this.optionalString(item?.messageTimestamp) ||
      this.optionalString(item?.timestamp) ||
      String(Date.now());

    const body =
      this.optionalString(
        item?.message?.conversation || item?.body || item?.text,
      ) || "message";

    return `sync_${remoteJid}_${timestamp}_${this.hashLike(body)}`;
  }

  private hashLike(value: string): string {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }

    return Math.abs(hash).toString(16);
  }

  private clampNumber(
    value: unknown,
    defaultValue: number,
    min: number,
    max: number,
  ): number {
    const numberValue = typeof value === "number" ? value : Number(value);

    if (Number.isNaN(numberValue)) {
      return defaultValue;
    }

    return Math.min(Math.max(numberValue, min), max);
  }

  private optionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();

    return trimmed || null;
  }

  private async getDemoClient() {
    return this.prisma.client.upsert({
      where: {
        slug: "panoram-demo",
      },
      update: {},
      create: {
        name: "Panoram Demo",
        slug: "panoram-demo",
      },
    });
  }

  private async hydrateMessageMedia(params: {
    instanceName: string;
    rawMessage: unknown;
    message: {
      messageType: string;
      mediaUrl: string | null;
      mediaMimeType: string | null;
      mediaFileName: string | null;
    };
  }) {
    const mediaTypes = ["image", "audio", "video", "document", "sticker"];

    if (!mediaTypes.includes(params.message.messageType)) {
      return;
    }

    const downloaded = await this.tryDownloadMediaAsDataUrl(
      params.instanceName,
      params.rawMessage,
      params.message.mediaMimeType,
    );

    if (!downloaded) {
      return;
    }

    params.message.mediaUrl = downloaded.mediaUrl;
    params.message.mediaMimeType =
      downloaded.mimeType || params.message.mediaMimeType;
    params.message.mediaFileName =
      downloaded.fileName || params.message.mediaFileName;
  }

  private async tryDownloadMediaAsDataUrl(
    instanceName: string,
    rawMessage: unknown,
    fallbackMimeType: string | null,
  ): Promise<{
    mediaUrl: string;
    mimeType: string | null;
    fileName: string | null;
  } | null> {
    const encodedInstanceName = encodeURIComponent(instanceName);

    const attempts = [
      {
        path: `/chat/getBase64FromMediaMessage/${encodedInstanceName}`,
        body: {
          message: rawMessage,
          convertToMp4: false,
        },
      },
      {
        path: `/chat/getBase64FromMediaMessage/${encodedInstanceName}`,
        body: rawMessage as Record<string, unknown>,
      },
      {
        path: `/chat/getBase64FromMediaMessage/${encodedInstanceName}`,
        body: {
          key: (rawMessage as any)?.key || (rawMessage as any)?.message?.key,
          message:
            (rawMessage as any)?.message?.message ||
            (rawMessage as any)?.message ||
            (rawMessage as any)?.data?.message,
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const response = await this.callEvolution(
          "POST",
          attempt.path,
          attempt.body,
        );
        const parsed = this.extractBase64Media(response, fallbackMimeType);

        if (parsed) {
          return parsed;
        }
      } catch {
        // tenta próximo formato
      }
    }

    return null;
  }

  private extractBase64Media(
    response: unknown,
    fallbackMimeType: string | null,
  ): {
    mediaUrl: string;
    mimeType: string | null;
    fileName: string | null;
  } | null {
    const data = response as any;

    const rawBase64 =
      data?.base64 ||
      data?.media ||
      data?.data ||
      data?.data?.base64 ||
      data?.data?.media ||
      data?.response?.base64 ||
      data?.response?.media;

    if (typeof rawBase64 !== "string" || !rawBase64.trim()) {
      return null;
    }

    if (rawBase64.startsWith("data:")) {
      return {
        mediaUrl: rawBase64,
        mimeType:
          this.extractMimeTypeFromDataUrl(rawBase64) || fallbackMimeType,
        fileName:
          this.optionalString(data?.fileName) ||
          this.optionalString(data?.filename) ||
          this.optionalString(data?.data?.fileName) ||
          null,
      };
    }

    const mimeType =
      this.optionalString(data?.mimetype) ||
      this.optionalString(data?.mimeType) ||
      this.optionalString(data?.data?.mimetype) ||
      this.optionalString(data?.data?.mimeType) ||
      fallbackMimeType ||
      "application/octet-stream";

    return {
      mediaUrl: `data:${this.normalizeDataUrlMimeType(mimeType)};base64,${rawBase64}`,
      mimeType,
      fileName:
        this.optionalString(data?.fileName) ||
        this.optionalString(data?.filename) ||
        this.optionalString(data?.data?.fileName) ||
        null,
    };
  }

  private extractMimeTypeFromDataUrl(dataUrl: string): string | null {
    const match = dataUrl.match(/^data:([^;]+);base64,/);

    return match?.[1] || null;
  }

  async hydrateConversationMedia(
    conversationId: string,
    messagesPerChat = 500,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        id: conversationId,
      },
      include: {
        whatsappInstance: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    if (!conversation.externalChatId) {
      throw new BadRequestException("Conversation externalChatId is required");
    }

    if (!conversation.whatsappInstance?.name) {
      throw new BadRequestException(
        "Conversation whatsapp instance is required",
      );
    }

    const mediaTypes = ["image", "audio", "video", "document", "sticker"];

    const messagesToHydrate = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        messageType: {
          in: mediaTypes,
        },
        OR: [
          {
            mediaUrl: null,
          },
          {
            mediaUrl: "",
          },
          {
            mediaUrl: {
              startsWith: "http",
            },
          },
          {
            mediaUrl: {
              contains: "mmg.whatsapp.net",
            },
          },
          {
            mediaUrl: {
              endsWith: ".enc",
            },
          },
        ],
      },
      orderBy: {
        sentAt: "desc",
      },
      take: 80,
    });

    if (!messagesToHydrate.length) {
      return {
        status: "ok",
        conversationId: conversation.id,
        rawMessagesFound: 0,
        messagesChecked: 0,
        messagesUpdated: 0,
        messagesNotFoundInEvolution: 0,
      };
    }

    const rawMessagesPayload = await this.fetchMessages(
      conversation.whatsappInstance.name,
      conversation.externalChatId,
      messagesPerChat,
    );

    const rawMessages = this.extractArray(rawMessagesPayload);

    let messagesUpdated = 0;
    let messagesNotFoundInEvolution = 0;
    let messagesWithoutBase64 = 0;

    for (const localMessage of messagesToHydrate) {
      if (!localMessage.externalMessageId) {
        messagesNotFoundInEvolution += 1;
        continue;
      }

      const rawMessage =
        rawMessages.find((message: any) => {
          const key =
            message?.key || message?.message?.key || message?.data?.key || {};

          return (
            key?.id === localMessage.externalMessageId ||
            message?.id === localMessage.externalMessageId ||
            message?.messageId === localMessage.externalMessageId ||
            message?.externalMessageId === localMessage.externalMessageId
          );
        }) || null;

      if (!rawMessage) {
        messagesNotFoundInEvolution += 1;
        continue;
      }

      const normalized = this.normalizeMessage(
        rawMessage,
        conversation.externalChatId,
      );

      await this.hydrateMessageMedia({
        instanceName: conversation.whatsappInstance.name,
        rawMessage,
        message: normalized,
      });

      if (!normalized.mediaUrl || !normalized.mediaUrl.startsWith("data:")) {
        messagesWithoutBase64 += 1;
        continue;
      }

      await this.prisma.message.update({
        where: {
          id: localMessage.id,
        },
        data: {
          messageType: normalized.messageType || localMessage.messageType,
          body: normalized.body || localMessage.body,
          mediaUrl: normalized.mediaUrl,
          mediaMimeType: normalized.mediaMimeType || localMessage.mediaMimeType,
          mediaFileName: normalized.mediaFileName || localMessage.mediaFileName,
        },
      });

      messagesUpdated += 1;
    }

    return {
      status: "ok",
      conversationId: conversation.id,
      externalChatId: conversation.externalChatId,
      instanceName: conversation.whatsappInstance.name,
      rawMessagesFound: rawMessages.length,
      messagesChecked: messagesToHydrate.length,
      messagesUpdated,
      messagesNotFoundInEvolution,
      messagesWithoutBase64,
    };
  }

  private extractProfilePictureUrl(item: any): string | null {
    return (
      this.optionalString(item?.profilePictureUrl) ||
      this.optionalString(item?.profilePicUrl) ||
      this.optionalString(item?.pictureUrl) ||
      this.optionalString(item?.avatar) ||
      this.optionalString(item?.profilePicture) ||
      this.optionalString(item?.data?.profilePictureUrl) ||
      this.optionalString(item?.data?.profilePicUrl) ||
      this.optionalString(item?.contact?.profilePictureUrl) ||
      this.optionalString(item?.contact?.profilePicUrl) ||
      null
    );
  }

  private normalizeDataUrlMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase();

    if (normalized.includes("audio/ogg") || normalized.includes("opus")) {
      return "audio/ogg";
    }

    if (normalized.includes("image/jpeg")) {
      return "image/jpeg";
    }

    if (normalized.includes("image/png")) {
      return "image/png";
    }

    if (normalized.includes("image/webp")) {
      return "image/webp";
    }

    if (normalized.includes("video/mp4")) {
      return "video/mp4";
    }

    if (normalized.includes("application/pdf")) {
      return "application/pdf";
    }

    return mimeType.split(";")[0].trim() || "application/octet-stream";
  }
}
