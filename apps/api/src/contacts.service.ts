import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { getPipelineStageLabel } from "./leads.pipeline";

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async listContacts(query: {
    search?: string;
    take?: number;
    skip?: number;
    tag?: string;
  }) {
    const client = await this.getDemoClient();
    const take = this.clampTake(query.take);
    const skip = Math.max(query.skip || 0, 0);
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const tag = typeof query.tag === "string" ? query.tag.trim() : "";

    const where: Prisma.LeadWhereInput = {
      clientId: client.id,
      conversations: {
        some: {
          externalChatId: {
            endsWith: "@s.whatsapp.net",
          },
        },
      },
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(tag
        ? {
            tagAssignments: {
              some: {
                tag: {
                  slug: this.slugify(tag),
                },
              },
            },
          }
        : {}),
    };

    const [total, contacts] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: {
          updatedAt: "desc",
        },
        skip,
        take,
        include: {
          tagAssignments: {
            include: {
              tag: true,
            },
          },
          conversations: {
            where: {
              externalChatId: {
                endsWith: "@s.whatsapp.net",
              },
            },
            orderBy: {
              lastMessageAt: "desc",
            },
            take: 1,
          },
          messages: {
            orderBy: {
              sentAt: "desc",
            },
            take: 1,
          },
          attributions: {
            orderBy: {
              attributedAt: "desc",
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
      contacts: contacts.map((contact) => this.formatContactListItem(contact)),
    };
  }

  async getContact(contactId: string) {
    const client = await this.getDemoClient();
    const contact = await this.findContactOrThrow(client.id, contactId);

    return this.formatContactDetail(contact);
  }

  async updateContact(
    contactId: string,
    body: {
      name?: unknown;
      email?: unknown;
      status?: unknown;
      currentStage?: unknown;
      assignedUserId?: unknown;
    },
  ) {
    const client = await this.getDemoClient();

    await this.findContactOrThrow(client.id, contactId);

    const updated = await this.prisma.lead.update({
      where: {
        id: contactId,
      },
      data: {
        ...(typeof body.name === "string"
          ? { name: body.name.trim() || null }
          : {}),
        ...(typeof body.email === "string"
          ? { email: body.email.trim() || null }
          : {}),
        ...(typeof body.status === "string"
          ? { status: body.status.trim() }
          : {}),
        ...(typeof body.currentStage === "string"
          ? { currentStage: body.currentStage.trim() || null }
          : {}),
        ...(typeof body.assignedUserId === "string"
          ? { assignedUserId: body.assignedUserId.trim() || null }
          : {}),
      },
      include: this.contactDetailInclude(),
    });

    return this.formatContactDetail(updated);
  }

  async addContactTag(
    contactId: string,
    body: {
      name?: unknown;
      color?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const contact = await this.findContactOrThrow(client.id, contactId);
    const name = this.requiredString(body.name, "name");
    const slug = this.slugify(name);
    const color = this.optionalString(body.color);

    const tag = await this.prisma.leadTag.upsert({
      where: {
        clientId_slug: {
          clientId: client.id,
          slug,
        },
      },
      update: {
        name,
        color,
      },
      create: {
        clientId: client.id,
        name,
        slug,
        color,
      },
    });

    await this.prisma.leadTagAssignment.upsert({
      where: {
        leadId_tagId: {
          leadId: contact.id,
          tagId: tag.id,
        },
      },
      update: {},
      create: {
        clientId: client.id,
        leadId: contact.id,
        tagId: tag.id,
      },
    });

    return this.getContact(contact.id);
  }

  async removeContactTag(contactId: string, rawTag: string) {
    const client = await this.getDemoClient();
    const contact = await this.findContactOrThrow(client.id, contactId);
    const tag = decodeURIComponent(rawTag || "").trim();

    if (!tag) {
      throw new BadRequestException("tag is required");
    }

    const deleted = await this.prisma.leadTagAssignment.deleteMany({
      where: {
        clientId: client.id,
        leadId: contact.id,
        OR: [
          {
            tagId: tag,
          },
          {
            tag: {
              slug: this.slugify(tag),
            },
          },
        ],
      },
    });

    return {
      removed: deleted.count,
    };
  }

  async addContactNote(
    contactId: string,
    body: {
      body?: unknown;
      createdBy?: unknown;
    },
  ) {
    const client = await this.getDemoClient();
    const contact = await this.findContactOrThrow(client.id, contactId);
    const noteBody = this.requiredString(body.body, "body");
    const createdBy = this.optionalString(body.createdBy);

    const note = await this.prisma.leadNote.create({
      data: {
        clientId: client.id,
        leadId: contact.id,
        body: noteBody,
        createdBy,
      },
    });

    return {
      note,
    };
  }

  async getContactTimeline(contactId: string) {
    const client = await this.getDemoClient();
    const contact = await this.findContactOrThrow(client.id, contactId);

    const [messages, notes, stages, attributions, conversions] =
      await this.prisma.$transaction([
        this.prisma.message.findMany({
          where: {
            clientId: client.id,
            leadId: contact.id,
          },
          orderBy: {
            sentAt: "desc",
          },
          take: 100,
        }),
        this.prisma.leadNote.findMany({
          where: {
            clientId: client.id,
            leadId: contact.id,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 100,
        }),
        this.prisma.leadStageHistory.findMany({
          where: {
            clientId: client.id,
            leadId: contact.id,
          },
          orderBy: {
            changedAt: "desc",
          },
          take: 100,
        }),
        this.prisma.leadAttribution.findMany({
          where: {
            clientId: client.id,
            leadId: contact.id,
          },
          orderBy: {
            attributedAt: "desc",
          },
          take: 100,
        }),
        this.prisma.conversionEvent.findMany({
          where: {
            clientId: client.id,
            leadId: contact.id,
          },
          orderBy: {
            occurredAt: "desc",
          },
          take: 100,
        }),
      ]);

    const events = [
      ...messages.map((message: any) => ({
        type: "message",
        occurredAt: message.sentAt,
        data: message,
      })),
      ...notes.map((note: any) => ({
        type: "note",
        occurredAt: note.createdAt,
        data: note,
      })),
      ...stages.map((stage: any) => ({
        type: "stage_change",
        occurredAt: stage.changedAt,
        data: stage,
      })),
      ...attributions.map((attribution: any) => ({
        type: "attribution",
        occurredAt: attribution.attributedAt,
        data: attribution,
      })),
      ...conversions.map((conversion: any) => ({
        type: "conversion_event",
        occurredAt: conversion.occurredAt,
        data: conversion,
      })),
    ].sort((a, b) => {
      return (
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
      );
    });

    return {
      contact: {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
      },
      events,
    };
  }

  private async findContactOrThrow(clientId: string, contactId: string) {
    const contact = await this.prisma.lead.findFirst({
      where: {
        id: contactId,
        clientId,
        conversations: {
          some: {
            externalChatId: {
              endsWith: "@s.whatsapp.net",
            },
          },
        },
      },
      include: this.contactDetailInclude(),
    });

    if (!contact) {
      throw new NotFoundException("Contact not found");
    }

    return contact;
  }

  private contactDetailInclude() {
    return {
      tagAssignments: {
        include: {
          tag: true,
        },
      },
      conversations: {
        where: {
          externalChatId: {
            endsWith: "@s.whatsapp.net",
          },
        },
        orderBy: {
          lastMessageAt: "desc" as const,
        },
        include: {
          whatsappInstance: true,
        },
      },
      messages: {
        orderBy: {
          sentAt: "desc" as const,
        },
        take: 20,
      },
      attributions: {
        orderBy: {
          attributedAt: "desc" as const,
        },
      },
      notes: {
        orderBy: {
          createdAt: "desc" as const,
        },
      },
      stageHistory: {
        orderBy: {
          changedAt: "desc" as const,
        },
      },
      conversionEvents: {
        orderBy: {
          occurredAt: "desc" as const,
        },
      },
    };
  }

  private formatContactListItem(contact: any) {
    const currentStage = contact.currentStage || "new_lead";

    return {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      status: contact.status,
      source: contact.source,
      currentStage,
      currentStageLabel: getPipelineStageLabel(currentStage),
      assignedUserId: contact.assignedUserId,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      tags: contact.tagAssignments.map((assignment: any) => assignment.tag),
      latestConversation: contact.conversations[0] || null,
      latestMessage: contact.messages[0] || null,
      latestAttribution: contact.attributions[0] || null,
    };
  }

  private formatContactDetail(contact: any) {
    const currentStage = contact.currentStage || "new_lead";

    return {
      ...contact,
      currentStage,
      currentStageLabel: getPipelineStageLabel(currentStage),
      tags: contact.tagAssignments.map((assignment: any) => assignment.tag),
    };
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

  private slugify(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
  }
}
