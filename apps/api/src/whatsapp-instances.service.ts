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

    return {
      status: "ok",
      instanceName,
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
