import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import {
  getPipelineStageLabel,
  isPipelineStage,
  PIPELINE_STAGES,
} from "./leads.pipeline";

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async listLeads(query: {
    stage?: string;
    search?: string;
    take?: number;
    skip?: number;
  }) {
    const client = await this.getDemoClient();
    const take = this.clampTake(query.take);
    const skip = Math.max(query.skip || 0, 0);

    if (query.stage && !isPipelineStage(query.stage)) {
      throw new BadRequestException("Invalid pipeline stage");
    }

    const where: Prisma.LeadWhereInput = {
      clientId: client.id,
      ...(query.stage ? this.buildStageFilter(query.stage) : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, leads] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: {
          updatedAt: "desc",
        },
        skip,
        take,
        include: {
          attributions: {
            orderBy: {
              attributedAt: "desc",
            },
            take: 1,
          },
          conversations: {
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
        },
      }),
    ]);

    return {
      stages: PIPELINE_STAGES,
      pagination: {
        total,
        take,
        skip,
      },
      leads: leads.map((lead) => this.formatLeadListItem(lead)),
    };
  }

  async getLead(leadId: string) {
    const client = await this.getDemoClient();
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        clientId: client.id,
      },
      include: {
        attributions: {
          orderBy: {
            attributedAt: "desc",
          },
        },
        conversations: {
          orderBy: {
            lastMessageAt: "desc",
          },
          include: {
            whatsappInstance: true,
          },
        },
        messages: {
          orderBy: {
            sentAt: "asc",
          },
        },
        stageHistory: {
          orderBy: {
            changedAt: "desc",
          },
        },
        conversionEvents: {
          orderBy: {
            occurredAt: "desc",
          },
        },
      },
    });

    if (!lead) {
      throw new NotFoundException("Lead not found");
    }

    return {
      ...lead,
      currentStage: lead.currentStage || "new_lead",
      currentStageLabel: getPipelineStageLabel(lead.currentStage),
      stages: PIPELINE_STAGES,
    };
  }

  async updateLeadStage(
    leadId: string,
    body: {
      stage?: unknown;
      note?: unknown;
      changedBy?: unknown;
    },
  ) {
    const client = await this.getDemoClient();

    if (!isPipelineStage(body.stage)) {
      throw new BadRequestException("Invalid pipeline stage");
    }

    const toStage = body.stage;
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const changedBy =
      typeof body.changedBy === "string" ? body.changedBy.trim() || null : null;

    const result = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: {
          id: leadId,
          clientId: client.id,
        },
      });

      if (!lead) {
        throw new NotFoundException("Lead not found");
      }

      const fromStage = lead.currentStage || "new_lead";

      if (fromStage === toStage) {
        return {
          lead,
          stageChanged: false,
          conversionEventCreated: false,
        };
      }

      const updatedLead = await tx.lead.update({
        where: {
          id: lead.id,
        },
        data: {
          currentStage: toStage,
          status: toStage,
        },
      });

      await tx.leadStageHistory.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          fromStage,
          toStage,
          changedBy,
          source: "api",
          note,
        },
      });

      let conversionEventCreated = false;

      if (toStage === "qualified") {
        const existingQualifiedEvent = await tx.conversionEvent.findFirst({
          where: {
            clientId: client.id,
            leadId: lead.id,
            eventName: "lead_qualified",
          },
        });

        if (!existingQualifiedEvent) {
          await tx.conversionEvent.create({
            data: {
              clientId: client.id,
              leadId: lead.id,
              eventName: "lead_qualified",
              source: "crm",
              payload: {
                fromStage,
                toStage,
              },
            },
          });

          conversionEventCreated = true;
        }
      }

      return {
        lead: updatedLead,
        stageChanged: true,
        conversionEventCreated,
      };
    });

    return {
      lead: {
        ...result.lead,
        currentStage: result.lead.currentStage || "new_lead",
        currentStageLabel: getPipelineStageLabel(result.lead.currentStage),
      },
      stageChanged: result.stageChanged,
      conversionEventCreated: result.conversionEventCreated,
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

  private buildStageFilter(stage: string): Prisma.LeadWhereInput {
    if (stage === "new_lead") {
      return {
        OR: [{ currentStage: "new_lead" }, { currentStage: null }],
      };
    }

    return {
      currentStage: stage,
    };
  }

  private formatLeadListItem(lead: any) {
    const currentStage = lead.currentStage || "new_lead";

    return {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      status: lead.status,
      source: lead.source,
      currentStage,
      currentStageLabel: getPipelineStageLabel(currentStage),
      assignedUserId: lead.assignedUserId,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      latestAttribution: lead.attributions[0] || null,
      latestConversation: lead.conversations[0] || null,
      latestMessage: lead.messages[0] || null,
    };
  }
}
