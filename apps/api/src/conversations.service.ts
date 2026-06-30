import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listConversations(query: {
    search?: string;
    take?: number;
    skip?: number;
    instanceName?: string;
    status?: string;
    archived?: string;
  }) {
    const client = await this.getDemoClient();

    const take = this.clampTake(query.take);
    const skip = Math.max(query.skip || 0, 0);
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const instanceName =
      typeof query.instanceName === "string" ? query.instanceName.trim() : "";
    const status = typeof query.status === "string" ? query.status.trim() : "";

    const where: Prisma.ConversationWhereInput = {
      clientId: client.id,
      externalChatId: {
        endsWith: "@s.whatsapp.net",
      },
      ...(query.archived === "true"
        ? {
            archivedAt: {
              not: null,
            },
          }
        : query.archived === "false"
          ? {
              archivedAt: null,
            }
          : {}),
      ...(status
        ? {
            status,
          }
        : {}),
      ...(instanceName
        ? {
            whatsappInstance: {
              is: {
                name: instanceName,
              },
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              {
                leadPhone: {
                  contains: search,
                },
              },
              {
                externalChatId: {
                  contains: search,
                },
              },
              {
                lead: {
                  is: {
                    name: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
              {
                lead: {
                  is: {
                    phone: {
                      contains: search,
                    },
                  },
                },
              },
              {
                messages: {
                  some: {
                    body: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [total, conversations] = await this.prisma.$transaction([
      this.prisma.conversation.count({
        where,
      }),
      this.prisma.conversation.findMany({
        where,
        orderBy: [
          {
            lastMessageAt: "desc",
          },
          {
            updatedAt: "desc",
          },
        ],
        skip,
        take,
        include: {
          lead: true,
          whatsappInstance: true,
          messages: {
            orderBy: {
              sentAt: "desc",
            },
            take: 1,
          },
        },
      }),
    ]);

    return {
      pagination: {
        total,
        take,
        skip,
      },
      conversations: conversations.map((conversation) => {
        const latestMessage = conversation.messages[0] || null;
        const lead = conversation.lead;

        return {
          id: conversation.id,
          clientId: conversation.clientId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          externalChatId: conversation.externalChatId,
          leadPhone: conversation.leadPhone,
          status: conversation.status,
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,

          contact: {
            id: lead.id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            source: lead.source,
            currentStage: lead.currentStage || "new_lead",
            status: lead.status,
          },

          whatsappInstance: conversation.whatsappInstance
            ? {
                id: conversation.whatsappInstance.id,
                name: conversation.whatsappInstance.name,
                phoneNumber: conversation.whatsappInstance.phoneNumber,
                status: conversation.whatsappInstance.status,
              }
            : null,

          latestMessage: latestMessage
            ? {
                id: latestMessage.id,
                externalMessageId: latestMessage.externalMessageId,
                direction: latestMessage.direction,
                messageType: latestMessage.messageType,
                body: latestMessage.body,
                mediaUrl: latestMessage.mediaUrl,
                mediaMimeType: latestMessage.mediaMimeType,
                mediaFileName: latestMessage.mediaFileName,
                fromPhone: latestMessage.fromPhone,
                toPhone: latestMessage.toPhone,
                sentAt: latestMessage.sentAt,
                createdAt: latestMessage.createdAt,
              }
            : null,

          unreadCount: 0,
        };
      }),
    };
  }

  async listConversationMessages(
    conversationId: string,
    query: {
      take?: number;
      before?: string;
    },
  ) {
    const client = await this.getDemoClient();

    const take = this.clampTake(query.take);
    const beforeDate = this.optionalDate(query.before);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        clientId: client.id,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
      include: {
        lead: true,
        whatsappInstance: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    const where: Prisma.MessageWhereInput = {
      clientId: client.id,
      conversationId: conversation.id,
      ...(beforeDate
        ? {
            sentAt: {
              lt: beforeDate,
            },
          }
        : {}),
    };

    const [total, messagesDesc] = await this.prisma.$transaction([
      this.prisma.message.count({
        where: {
          clientId: client.id,
          conversationId: conversation.id,
        },
      }),
      this.prisma.message.findMany({
        where,
        orderBy: {
          sentAt: "desc",
        },
        take,
      }),
    ]);

    const messages = [...messagesDesc].reverse();

    return {
      conversation: {
        id: conversation.id,
        clientId: conversation.clientId,
        leadId: conversation.leadId,
        channel: conversation.channel,
        externalChatId: conversation.externalChatId,
        leadPhone: conversation.leadPhone,
        status: conversation.status,
        lastMessageAt: conversation.lastMessageAt,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,

        contact: {
          id: conversation.lead.id,
          name: conversation.lead.name,
          phone: conversation.lead.phone,
          email: conversation.lead.email,
          source: conversation.lead.source,
          currentStage: conversation.lead.currentStage || "new_lead",
          status: conversation.lead.status,
        },

        whatsappInstance: conversation.whatsappInstance
          ? {
              id: conversation.whatsappInstance.id,
              name: conversation.whatsappInstance.name,
              phoneNumber: conversation.whatsappInstance.phoneNumber,
              status: conversation.whatsappInstance.status,
            }
          : null,
      },

      pagination: {
        total,
        take,
        before: beforeDate,
        returned: messages.length,
        hasMore: messagesDesc.length === take,
        nextBefore: messages.length ? messages[0].sentAt : null,
      },

      messages: messages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        leadId: message.leadId,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        messageType: message.messageType,
        body: message.body,
        mediaUrl: message.mediaUrl,
        mediaMimeType: message.mediaMimeType,
        mediaFileName: message.mediaFileName,
        fromPhone: message.fromPhone,
        toPhone: message.toPhone,
        sentAt: message.sentAt,
        createdAt: message.createdAt,
      })),
    };
  }

  async sendConversationTextMessage(
    conversationId: string,
    body: {
      text?: unknown;
    },
  ) {
    const text = this.requiredString(body.text, "text");
    const context = await this.getConversationContext(conversationId);

    const evolutionResponse = await this.callEvolution({
      instanceName: context.instanceName,
      endpoint: "sendText",
      payload: {
        number: context.lead.phone,
        text,
      },
    });

    const externalMessageId = this.extractEvolutionMessageId(evolutionResponse);

    const existingMessage = await this.prisma.message.findUnique({
      where: {
        clientId_externalMessageId: {
          clientId: context.client.id,
          externalMessageId,
        },
      },
    });

    if (existingMessage) {
      await this.prisma.conversation.update({
        where: {
          id: context.conversation.id,
        },
        data: {
          lastMessageAt: existingMessage.sentAt,
        },
      });

      return {
        status: "ok",
        duplicated: true,
        message: existingMessage,
        evolutionResponse,
      };
    }

    const message = await this.prisma.message.create({
      data: {
        clientId: context.client.id,
        leadId: context.lead.id,
        conversationId: context.conversation.id,
        externalMessageId,
        direction: "outbound",
        messageType: "text",
        body: text,
        fromPhone: context.instancePhone,
        toPhone: context.lead.phone,
        sentAt: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: {
        id: context.conversation.id,
      },
      data: {
        lastMessageAt: message.sentAt,
      },
    });

    return {
      status: "ok",
      duplicated: false,
      message,
      evolutionResponse,
    };
  }

  async sendConversationMediaMessage(
    conversationId: string,
    body: {
      mediaBase64?: unknown;
      mediaUrl?: unknown;
      mimeType?: unknown;
      fileName?: unknown;
      caption?: unknown;
      mediaType?: unknown;
    },
  ) {
    const mediaBase64 = this.optionalString(body.mediaBase64);
    const mediaUrl = this.optionalString(body.mediaUrl);
    const mimeType = this.requiredString(body.mimeType, "mimeType");
    const fileName = this.optionalString(body.fileName);
    const caption = this.optionalString(body.caption);
    const mediaType = this.requiredString(body.mediaType, "mediaType");

    const allowedMediaTypes = ["image", "audio", "video", "document"];

    if (!allowedMediaTypes.includes(mediaType)) {
      throw new BadRequestException(
        "mediaType must be image, audio, video or document",
      );
    }

    if (!mediaBase64 && !mediaUrl) {
      throw new BadRequestException("mediaBase64 or mediaUrl is required");
    }

    const context = await this.getConversationContext(conversationId);

    const media = mediaBase64
      ? mediaBase64.includes(",")
        ? mediaBase64.split(",").pop()
        : mediaBase64
      : mediaUrl;

    const evolutionResponse = await this.callEvolution({
      instanceName: context.instanceName,
      endpoint: "sendMedia",
      payload: {
        number: context.lead.phone,
        mediatype: mediaType,
        mimetype: mimeType,
        caption: caption || "",
        media,
        fileName: fileName || undefined,
      },
    });

    const externalMessageId = this.extractEvolutionMessageId(evolutionResponse);

    const existingMessage = await this.prisma.message.findUnique({
      where: {
        clientId_externalMessageId: {
          clientId: context.client.id,
          externalMessageId,
        },
      },
    });

    if (existingMessage) {
      await this.prisma.conversation.update({
        where: {
          id: context.conversation.id,
        },
        data: {
          lastMessageAt: existingMessage.sentAt,
        },
      });

      return {
        status: "ok",
        duplicated: true,
        message: existingMessage,
        evolutionResponse,
      };
    }

    const message = await this.prisma.message.create({
      data: {
        clientId: context.client.id,
        leadId: context.lead.id,
        conversationId: context.conversation.id,
        externalMessageId,
        direction: "outbound",
        messageType: mediaType,
        body: caption,
        mediaUrl: mediaUrl || null,
        mediaMimeType: mimeType,
        mediaFileName: fileName,
        fromPhone: context.instancePhone,
        toPhone: context.lead.phone,
        sentAt: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: {
        id: context.conversation.id,
      },
      data: {
        lastMessageAt: message.sentAt,
      },
    });

    return {
      status: "ok",
      duplicated: false,
      message,
      evolutionResponse,
    };
  }

  async sendTextMessage(
    leadId: string,
    body: {
      text?: unknown;
    },
  ) {
    const text = this.requiredString(body.text, "text");
    const context = await this.getLeadConversationContext(leadId);

    const evolutionResponse = await this.callEvolution({
      instanceName: context.instanceName,
      endpoint: "sendText",
      payload: {
        number: context.lead.phone,
        text,
      },
    });

    const externalMessageId = this.extractEvolutionMessageId(evolutionResponse);

    const message = await this.prisma.message.create({
      data: {
        clientId: context.client.id,
        leadId: context.lead.id,
        conversationId: context.conversation.id,
        externalMessageId,
        direction: "outbound",
        messageType: "text",
        body: text,
        fromPhone: context.instancePhone,
        toPhone: context.lead.phone,
        sentAt: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: {
        id: context.conversation.id,
      },
      data: {
        lastMessageAt: message.sentAt,
      },
    });

    return {
      status: "ok",
      message,
      evolutionResponse,
    };
  }

  async sendMediaMessage(
    leadId: string,
    body: {
      mediaBase64?: unknown;
      mediaUrl?: unknown;
      mimeType?: unknown;
      fileName?: unknown;
      caption?: unknown;
      mediaType?: unknown;
    },
  ) {
    const mediaBase64 = this.optionalString(body.mediaBase64);
    const mediaUrl = this.optionalString(body.mediaUrl);
    const mimeType = this.requiredString(body.mimeType, "mimeType");
    const fileName = this.optionalString(body.fileName);
    const caption = this.optionalString(body.caption);
    const mediaType = this.requiredString(body.mediaType, "mediaType");

    if (!["image", "audio"].includes(mediaType)) {
      throw new BadRequestException("mediaType must be image or audio");
    }

    if (!mediaBase64 && !mediaUrl) {
      throw new BadRequestException("mediaBase64 or mediaUrl is required");
    }

    const context = await this.getLeadConversationContext(leadId);

    const media = mediaBase64
      ? mediaBase64.includes(",")
        ? mediaBase64.split(",").pop()
        : mediaBase64
      : mediaUrl;

    const evolutionResponse = await this.callEvolution({
      instanceName: context.instanceName,
      endpoint: "sendMedia",
      payload: {
        number: context.lead.phone,
        mediatype: mediaType,
        mimetype: mimeType,
        caption: caption || "",
        media,
        fileName: fileName || undefined,
      },
    });

    const externalMessageId = this.extractEvolutionMessageId(evolutionResponse);

    const message = await this.prisma.message.create({
      data: {
        clientId: context.client.id,
        leadId: context.lead.id,
        conversationId: context.conversation.id,
        externalMessageId,
        direction: "outbound",
        messageType: mediaType,
        body: caption,
        mediaUrl: mediaUrl || null,
        mediaMimeType: mimeType,
        mediaFileName: fileName,
        fromPhone: context.instancePhone,
        toPhone: context.lead.phone,
        sentAt: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: {
        id: context.conversation.id,
      },
      data: {
        lastMessageAt: message.sentAt,
      },
    });

    return {
      status: "ok",
      message,
      evolutionResponse,
    };
  }

  private async getConversationContext(conversationId: string) {
    const client = await this.getDemoClient();

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        clientId: client.id,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
      include: {
        lead: true,
        whatsappInstance: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    const usableInstance = await this.resolveUsableInstance({
      clientId: client.id,
      currentInstance: conversation.whatsappInstance,
    });

    const instanceName =
      usableInstance?.name ||
      conversation.whatsappInstance?.name ||
      process.env.EVOLUTION_DEFAULT_INSTANCE;

    if (!instanceName) {
      throw new BadRequestException("Evolution instance name not configured");
    }

    return {
      client,
      conversation,
      lead: conversation.lead,
      instanceName,
      instancePhone:
        usableInstance?.phoneNumber ||
        conversation.whatsappInstance?.phoneNumber ||
        null,
    };
  }

  private async getLeadConversationContext(leadId: string) {
    const client = await this.getDemoClient();

    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        clientId: client.id,
      },
      include: {
        conversations: {
          orderBy: {
            lastMessageAt: "desc",
          },
          take: 1,
          include: {
            whatsappInstance: true,
          },
        },
      },
    });

    if (!lead) {
      throw new NotFoundException("Lead not found");
    }

    const conversation = lead.conversations[0];

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    const usableInstance = await this.resolveUsableInstance({
      clientId: client.id,
      currentInstance: conversation.whatsappInstance,
    });

    const instanceName =
      usableInstance?.name ||
      conversation.whatsappInstance?.name ||
      process.env.EVOLUTION_DEFAULT_INSTANCE;

    if (!instanceName) {
      throw new BadRequestException("Evolution instance name not configured");
    }

    return {
      client,
      lead,
      conversation,
      instanceName,
      instancePhone:
        usableInstance?.phoneNumber ||
        conversation.whatsappInstance?.phoneNumber ||
        null,
    };
  }

  private async resolveUsableInstance(params: {
    clientId: string;
    currentInstance: any;
  }) {
    if (params.currentInstance && params.currentInstance.status !== "deleted") {
      return params.currentInstance;
    }

    const defaultInstanceName = process.env.EVOLUTION_DEFAULT_INSTANCE;

    if (defaultInstanceName) {
      const defaultInstance = await this.prisma.whatsAppInstance.findFirst({
        where: {
          clientId: params.clientId,
          name: defaultInstanceName,
          status: {
            not: "deleted",
          },
        },
      });

      if (defaultInstance) {
        return defaultInstance;
      }
    }

    return this.prisma.whatsAppInstance.findFirst({
      where: {
        clientId: params.clientId,
        status: {
          not: "deleted",
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  }

  private async callEvolution(params: {
    instanceName: string;
    endpoint: "sendText" | "sendMedia";
    payload: Record<string, unknown>;
  }) {
    const baseUrl = process.env.EVOLUTION_API_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!baseUrl || !apiKey) {
      throw new BadRequestException("Evolution API env vars are missing");
    }

    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/message/${params.endpoint}/${encodeURIComponent(
        params.instanceName,
      )}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
        },
        body: JSON.stringify(params.payload),
      },
    );

    const text = await response.text();

    let data: unknown = text;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      throw new BadRequestException({
        message: "Evolution API request failed",
        status: response.status,
        response: data,
      });
    }

    return data;
  }

  private extractEvolutionMessageId(response: unknown): string {
    const data = response as any;

    return (
      data?.key?.id ||
      data?.message?.key?.id ||
      data?.data?.key?.id ||
      `outbound_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException(`${fieldName} is required`);
    }

    return value.trim();
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

  private clampTake(take?: number): number {
    if (!take || Number.isNaN(take)) {
      return 50;
    }

    return Math.min(Math.max(take, 1), 100);
  }

  private optionalDate(value: unknown): Date | null {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date;
  }

  async getConversation(conversationId: string) {
    const client = await this.getDemoClient();

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        clientId: client.id,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
      include: {
        lead: {
          include: {
            attributions: {
              orderBy: {
                attributedAt: "desc",
              },
              take: 5,
            },
            tagAssignments: {
              include: {
                tag: true,
              },
            },
          },
        },
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    return this.formatConversation(conversation);
  }

  async markConversationAsRead(conversationId: string) {
    const client = await this.getDemoClient();

    const conversation = await this.ensureConversation(
      client.id,
      conversationId,
    );

    const updated = await this.prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        unreadCount: 0,
        readAt: new Date(),
      },
      include: {
        lead: true,
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    return this.formatConversation(updated);
  }

  async archiveConversation(
    conversationId: string,
    body: {
      archived?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const conversation = await this.ensureConversation(
      client.id,
      conversationId,
    );
    const archived = body.archived !== false;

    const updated = await this.prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        archivedAt: archived ? new Date() : null,
      },
      include: {
        lead: true,
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    return this.formatConversation(updated);
  }

  async pinConversation(
    conversationId: string,
    body: {
      pinned?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const conversation = await this.ensureConversation(
      client.id,
      conversationId,
    );
    const pinned = body.pinned !== false;

    const updated = await this.prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        pinnedAt: pinned ? new Date() : null,
      },
      include: {
        lead: true,
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    return this.formatConversation(updated);
  }

  async updateConversationStatus(
    conversationId: string,
    body: {
      status?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const conversation = await this.ensureConversation(
      client.id,
      conversationId,
    );
    const status = this.requiredString(body.status, "status");

    const allowedStatuses = ["open", "closed", "pending", "archived"];

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException("Invalid conversation status");
    }

    const updated = await this.prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        status,
        archivedAt:
          status === "archived" ? new Date() : conversation.archivedAt,
      },
      include: {
        lead: true,
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    return this.formatConversation(updated);
  }

  async assignConversation(
    conversationId: string,
    body: {
      assignedUserId?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const conversation = await this.ensureConversation(
      client.id,
      conversationId,
    );
    const assignedUserId = this.optionalString(body.assignedUserId);

    const updated = await this.prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        assignedUserId,
      },
      include: {
        lead: true,
        whatsappInstance: true,
        messages: {
          orderBy: {
            sentAt: "desc",
          },
          take: 1,
        },
      },
    });

    return this.formatConversation(updated);
  }

  private async ensureConversation(clientId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        clientId,
        externalChatId: {
          endsWith: "@s.whatsapp.net",
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    return conversation;
  }

  private formatConversation(conversation: any) {
    const latestMessage = conversation.messages?.[0] || null;
    const lead = conversation.lead;

    return {
      id: conversation.id,
      clientId: conversation.clientId,
      leadId: conversation.leadId,
      channel: conversation.channel,
      externalChatId: conversation.externalChatId,
      leadPhone: conversation.leadPhone,
      status: conversation.status,
      unreadCount: conversation.unreadCount || 0,
      readAt: conversation.readAt,
      archivedAt: conversation.archivedAt,
      pinnedAt: conversation.pinnedAt,
      assignedUserId: conversation.assignedUserId,
      lastMessageAt: conversation.lastMessageAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,

      contact: lead
        ? {
            id: lead.id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            source: lead.source,
            currentStage: lead.currentStage || "new_lead",
            status: lead.status,
            attributions: lead.attributions || [],
            tags:
              lead.tagAssignments?.map((assignment: any) => assignment.tag) ||
              [],
          }
        : null,

      whatsappInstance: conversation.whatsappInstance
        ? {
            id: conversation.whatsappInstance.id,
            name: conversation.whatsappInstance.name,
            phoneNumber: conversation.whatsappInstance.phoneNumber,
            status: conversation.whatsappInstance.status,
          }
        : null,

      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            externalMessageId: latestMessage.externalMessageId,
            direction: latestMessage.direction,
            messageType: latestMessage.messageType,
            body: latestMessage.body,
            mediaUrl: latestMessage.mediaUrl,
            mediaMimeType: latestMessage.mediaMimeType,
            mediaFileName: latestMessage.mediaFileName,
            fromPhone: latestMessage.fromPhone,
            toPhone: latestMessage.toPhone,
            sentAt: latestMessage.sentAt,
            createdAt: latestMessage.createdAt,
          }
        : null,
    };
  }
}
