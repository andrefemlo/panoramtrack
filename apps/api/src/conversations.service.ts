import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

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

  private async getLeadConversationContext(leadId: string) {
    const client = await this.prisma.client.upsert({
      where: {
        slug: "panoram-demo",
      },
      update: {},
      create: {
        name: "Panoram Demo",
        slug: "panoram-demo",
      },
    });

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

    const instanceName =
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
      instancePhone: conversation.whatsappInstance?.phoneNumber || null,
    };
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
      `${baseUrl.replace(/\\/$/, "")}/message/${params.endpoint}/${params.instanceName}`,
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
}