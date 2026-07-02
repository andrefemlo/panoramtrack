import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";

type InstanceStatus = "active" | "inactive" | "deleted";

@Injectable()
export class WhatsappInstancesService {
  constructor(private readonly prisma: PrismaService) {}

  async listInstances(query: { status?: string; search?: string }) {
    const client = await this.getDemoClient();

    const search = typeof query.search === "string" ? query.search.trim() : "";
    const status = typeof query.status === "string" ? query.status.trim() : "";

    const where: Prisma.WhatsAppInstanceWhereInput = {
      clientId: client.id,
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phoneNumber: { contains: search } },
            ],
          }
        : {}),
    };

    const instances = await this.prisma.whatsAppInstance.findMany({
      where,
      orderBy: {
        updatedAt: "desc",
      },
      include: {
        _count: {
          select: {
            conversations: true,
          },
        },
      },
    });

    return {
      instances: instances.map((instance) => ({
        id: instance.id,
        clientId: instance.clientId,
        name: instance.name,
        phoneNumber: instance.phoneNumber,
        status: instance.status,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
        conversationCount: instance._count.conversations,
      })),
    };
  }

  async getInstance(rawInstanceName: string) {
    const client = await this.getDemoClient();
    const instanceName = this.decodeInstanceName(rawInstanceName);

    const instance = await this.prisma.whatsAppInstance.findFirst({
      where: {
        clientId: client.id,
        name: instanceName,
      },
      include: {
        conversations: {
          orderBy: {
            lastMessageAt: "desc",
          },
          take: 10,
          include: {
            lead: true,
          },
        },
        _count: {
          select: {
            conversations: true,
          },
        },
      },
    });

    if (!instance) {
      throw new NotFoundException("WhatsApp instance not found");
    }

    const evolutionStatus = await this.getEvolutionInstanceStatus(
      instance.name,
    );

    if (evolutionStatus && evolutionStatus !== instance.status) {
      await this.prisma.whatsAppInstance.update({
        where: {
          id: instance.id,
        },
        data: {
          status: evolutionStatus,
        },
      });

      instance.status = evolutionStatus;
    }

    return {
      id: instance.id,
      clientId: instance.clientId,
      name: instance.name,
      phoneNumber: instance.phoneNumber,
      status: instance.status,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      conversationCount: instance._count.conversations,
      recentConversations: instance.conversations.map((conversation) => ({
        id: conversation.id,
        leadId: conversation.leadId,
        leadName: conversation.lead.name,
        leadPhone: conversation.lead.phone,
        externalChatId: conversation.externalChatId,
        lastMessageAt: conversation.lastMessageAt,
        status: conversation.status,
      })),
    };
  }

  async refreshInstanceStatus(rawInstanceName: string) {
    const client = await this.getDemoClient();
    const instanceName = this.decodeInstanceName(rawInstanceName);
    const status = await this.getEvolutionInstanceStatus(instanceName);

    if (!status) {
      return {
        instanceName,
        status: "unknown",
        updated: false,
      };
    }

    const instance = await this.prisma.whatsAppInstance.upsert({
      where: {
        clientId_name: {
          clientId: client.id,
          name: instanceName,
        },
      },
      update: {
        status,
      },
      create: {
        clientId: client.id,
        name: instanceName,
        status,
      },
    });

    return {
      instance,
      updated: true,
    };
  }

  async reconnectInstance(rawInstanceName: string) {
    const instanceName = this.decodeInstanceName(rawInstanceName);

    const result = await this.callEvolutionWithFallback([
      {
        method: "GET",
        path: `/instance/connect/${encodeURIComponent(instanceName)}`,
      },
      {
        method: "POST",
        path: `/instance/connect/${encodeURIComponent(instanceName)}`,
        body: {},
      },
      {
        method: "POST",
        path: `/instance/restart/${encodeURIComponent(instanceName)}`,
        body: {},
      },
    ]);

    await this.refreshInstanceStatus(instanceName);

    const qrCode = this.extractQrCode(result);

    return {
      status: "ok",
      instanceName,
      qrCodeDataUrl: qrCode.dataUrl,
      qrCodeText: qrCode.text,
      pairingCode: qrCode.pairingCode,
      evolutionResponse: result,
    };
  }

  async logoutInstance(rawInstanceName: string) {
    const client = await this.getDemoClient();
    const instanceName = this.decodeInstanceName(rawInstanceName);

    const result = await this.callEvolutionWithFallback([
      {
        method: "DELETE",
        path: `/instance/logout/${encodeURIComponent(instanceName)}`,
      },
      {
        method: "POST",
        path: `/instance/logout/${encodeURIComponent(instanceName)}`,
        body: {},
      },
    ]);

    await this.prisma.whatsAppInstance.updateMany({
      where: {
        clientId: client.id,
        name: instanceName,
      },
      data: {
        status: "inactive",
      },
    });

    return {
      status: "ok",
      instanceName,
      evolutionResponse: result,
    };
  }

  async deleteInstance(rawInstanceName: string) {
    const client = await this.getDemoClient();
    const instanceName = this.decodeInstanceName(rawInstanceName);

    let evolutionResponse: unknown = null;

    try {
      evolutionResponse = await this.callEvolutionWithFallback([
        {
          method: "DELETE",
          path: `/instance/delete/${encodeURIComponent(instanceName)}`,
        },
        {
          method: "DELETE",
          path: `/instance/logout/${encodeURIComponent(instanceName)}`,
        },
      ]);
    } catch (error) {
      evolutionResponse = {
        warning:
          "Evolution delete/logout failed. Local instance was marked as deleted.",
      };
    }

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
      evolutionResponse,
    };
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

  private async callEvolutionWithFallback(
    attempts: Array<{
      method: "GET" | "POST" | "DELETE";
      path: string;
      body?: Record<string, unknown>;
    }>,
  ) {
    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        return await this.callEvolution(
          attempt.method,
          attempt.path,
          attempt.body,
        );
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new BadRequestException("Evolution request failed");
  }

  private async callEvolution(
    method: "GET" | "POST" | "DELETE",
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
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
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

  private extractQrCode(data: unknown): {
    dataUrl: string | null;
    text: string | null;
    pairingCode: string | null;
  } {
    const strings = this.collectStrings(data);
    const dataUrl = strings.find((value) =>
      /^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(value),
    );
    const rawBase64 = strings.find((value) =>
      /^[A-Za-z0-9+/=]{200,}$/.test(value),
    );
    const qrText = strings.find((value) =>
      /^(2@|https?:\/\/|wa:|WIFI:)/i.test(value),
    );
    const pairingCode = this.findStringByKey(data, [
      "pairingCode",
      "pairing_code",
      "code",
    ]);

    return {
      dataUrl: dataUrl || (rawBase64 ? `data:image/png;base64,${rawBase64}` : null),
      text: qrText || null,
      pairingCode: pairingCode || null,
    };
  }

  private collectStrings(value: unknown, depth = 0): string[] {
    if (depth > 8 || value === null || value === undefined) {
      return [];
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => this.collectStrings(item, depth + 1));
    }

    if (typeof value === "object") {
      return Object.values(value).flatMap((item) =>
        this.collectStrings(item, depth + 1),
      );
    }

    return [];
  }

  private findStringByKey(value: unknown, keys: string[], depth = 0): string | null {
    if (depth > 8 || !value || typeof value !== "object") {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.findStringByKey(item, keys, depth + 1);
        if (result) return result;
      }

      return null;
    }

    const record = value as Record<string, unknown>;
    const normalizedKeys = keys.map((key) => key.toLowerCase());

    for (const [key, childValue] of Object.entries(record)) {
      if (
        normalizedKeys.includes(key.toLowerCase()) &&
        typeof childValue === "string" &&
        childValue.trim()
      ) {
        return childValue.trim();
      }
    }

    for (const childValue of Object.values(record)) {
      const result = this.findStringByKey(childValue, keys, depth + 1);
      if (result) return result;
    }

    return null;
  }

  private decodeInstanceName(value: string): string {
    const instanceName = decodeURIComponent(value || "").trim();

    if (!instanceName) {
      throw new BadRequestException("instanceName is required");
    }

    return instanceName;
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
}
