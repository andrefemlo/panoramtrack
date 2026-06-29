import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
      conversations: {
        some: {
          externalChatId: {
            endsWith: "@s.whatsapp.net",
          },
        },
      },
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
        conversations: {
          some: {
            externalChatId: {
              endsWith: "@s.whatsapp.net",
            },
          },
        },
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
    const note =
      typeof body.note === "string" ? body.note.trim() || null : null;
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

  async listAttributionCandidates(
    leadId: string,
    query: {
      search?: string;
      take?: number;
      sinceHours?: number;
    },
  ) {
    const client = await this.getDemoClient();
    const take = Math.min(Math.max(query.take || 25, 1), 100);
    const sinceHours = Math.min(Math.max(query.sinceHours || 72, 1), 24 * 30);
    const clickedAfter = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        clientId: client.id,
      },
    });

    if (!lead) {
      throw new NotFoundException("Lead not found");
    }

    const search = typeof query.search === "string" ? query.search.trim() : "";

    const candidates = await this.prisma.clickEvent.findMany({
      where: {
        clientId: client.id,
        isMatched: false,
        clickedAt: {
          gte: clickedAfter,
        },
        ...(search
          ? {
              OR: [
                { clickCode: { contains: search, mode: "insensitive" } },
                { utmSource: { contains: search, mode: "insensitive" } },
                { utmMedium: { contains: search, mode: "insensitive" } },
                { utmCampaign: { contains: search, mode: "insensitive" } },
                { utmContent: { contains: search, mode: "insensitive" } },
                { utmTerm: { contains: search, mode: "insensitive" } },
                { fbclid: { contains: search, mode: "insensitive" } },
                { gclid: { contains: search, mode: "insensitive" } },
                {
                  trackingLink: {
                    campaignName: { contains: search, mode: "insensitive" },
                  },
                },
                {
                  trackingLink: {
                    adName: { contains: search, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        trackingLink: true,
      },
      orderBy: {
        clickedAt: "desc",
      },
      take,
    });

    return {
      lead: {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
      },
      candidates: candidates.map((candidate) => ({
        clickEventId: candidate.id,
        clickCode: candidate.clickCode,
        clickedAt: candidate.clickedAt,
        destinationWhatsappPhone: candidate.destinationWhatsappPhone,

        utmSource: candidate.utmSource,
        utmMedium: candidate.utmMedium,
        utmCampaign: candidate.utmCampaign,
        utmContent: candidate.utmContent,
        utmTerm: candidate.utmTerm,

        fbclid: candidate.fbclid,
        gclid: candidate.gclid,
        gbraid: candidate.gbraid,
        wbraid: candidate.wbraid,
        fbc: candidate.fbc,
        fbp: candidate.fbp,

        trackingLink: candidate.trackingLink
          ? {
              id: candidate.trackingLink.id,
              slug: candidate.trackingLink.slug,
              name: candidate.trackingLink.name,
              sourcePlatform: candidate.trackingLink.sourcePlatform,
              campaignName: candidate.trackingLink.campaignName,
              campaignId: candidate.trackingLink.campaignId,
              adsetName: candidate.trackingLink.adsetName,
              adsetId: candidate.trackingLink.adsetId,
              adName: candidate.trackingLink.adName,
              adId: candidate.trackingLink.adId,
            }
          : null,
      })),
    };
  }

  async createManualAttribution(
    leadId: string,
    body: {
      clickEventId?: unknown;

      sourcePlatform?: unknown;
      campaignName?: unknown;
      campaignId?: unknown;
      adsetName?: unknown;
      adsetId?: unknown;
      adName?: unknown;
      adId?: unknown;

      utmSource?: unknown;
      utmMedium?: unknown;
      utmCampaign?: unknown;
      utmContent?: unknown;
      utmTerm?: unknown;

      gclid?: unknown;
      gbraid?: unknown;
      wbraid?: unknown;
      fbclid?: unknown;
      fbc?: unknown;
      fbp?: unknown;
    },
  ) {
    const client = await this.getDemoClient();

    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        clientId: client.id,
      },
    });

    if (!lead) {
      throw new NotFoundException("Lead not found");
    }

    const clickEventId = this.optionalString(body.clickEventId);

    if (clickEventId) {
      const clickEvent = await this.prisma.clickEvent.findFirst({
        where: {
          id: clickEventId,
          clientId: client.id,
        },
        include: {
          trackingLink: true,
        },
      });

      if (!clickEvent) {
        throw new NotFoundException("ClickEvent not found");
      }

      if (clickEvent.isMatched && clickEvent.matchedLeadId !== lead.id) {
        throw new BadRequestException(
          "ClickEvent already matched to another lead",
        );
      }

      const attribution = await this.prisma.$transaction(async (tx) => {
        await tx.clickEvent.update({
          where: {
            id: clickEvent.id,
          },
          data: {
            isMatched: true,
            matchedLeadId: lead.id,
            matchedAt: new Date(),
          },
        });

        return tx.leadAttribution.upsert({
          where: {
            leadId_clickEventId: {
              leadId: lead.id,
              clickEventId: clickEvent.id,
            },
          },
          update: {
            matchMethod: "manual",
            matchConfidence: "manual",
          },
          create: {
            leadId: lead.id,
            clientId: client.id,
            trackingLinkId: clickEvent.trackingLinkId,
            clickEventId: clickEvent.id,

            sourcePlatform:
              this.optionalString(body.sourcePlatform) ||
              clickEvent.trackingLink.sourcePlatform,
            campaignName:
              this.optionalString(body.campaignName) ||
              clickEvent.trackingLink.campaignName,
            campaignId:
              this.optionalString(body.campaignId) ||
              clickEvent.trackingLink.campaignId,
            adsetName:
              this.optionalString(body.adsetName) ||
              clickEvent.trackingLink.adsetName,
            adsetId:
              this.optionalString(body.adsetId) ||
              clickEvent.trackingLink.adsetId,
            adName:
              this.optionalString(body.adName) ||
              clickEvent.trackingLink.adName,
            adId:
              this.optionalString(body.adId) || clickEvent.trackingLink.adId,

            utmSource:
              this.optionalString(body.utmSource) || clickEvent.utmSource,
            utmMedium:
              this.optionalString(body.utmMedium) || clickEvent.utmMedium,
            utmCampaign:
              this.optionalString(body.utmCampaign) || clickEvent.utmCampaign,
            utmContent:
              this.optionalString(body.utmContent) || clickEvent.utmContent,
            utmTerm: this.optionalString(body.utmTerm) || clickEvent.utmTerm,

            gclid: this.optionalString(body.gclid) || clickEvent.gclid,
            gbraid: this.optionalString(body.gbraid) || clickEvent.gbraid,
            wbraid: this.optionalString(body.wbraid) || clickEvent.wbraid,
            fbclid: this.optionalString(body.fbclid) || clickEvent.fbclid,
            fbc: this.optionalString(body.fbc) || clickEvent.fbc,
            fbp: this.optionalString(body.fbp) || clickEvent.fbp,

            matchMethod: "manual",
            matchConfidence: "manual",
          },
        });
      });

      return {
        attribution,
        clickEventMatched: true,
      };
    }

    const attribution = await this.prisma.leadAttribution.create({
      data: {
        leadId: lead.id,
        clientId: client.id,

        sourcePlatform: this.optionalString(body.sourcePlatform),
        campaignName: this.optionalString(body.campaignName),
        campaignId: this.optionalString(body.campaignId),
        adsetName: this.optionalString(body.adsetName),
        adsetId: this.optionalString(body.adsetId),
        adName: this.optionalString(body.adName),
        adId: this.optionalString(body.adId),

        utmSource: this.optionalString(body.utmSource),
        utmMedium: this.optionalString(body.utmMedium),
        utmCampaign: this.optionalString(body.utmCampaign),
        utmContent: this.optionalString(body.utmContent),
        utmTerm: this.optionalString(body.utmTerm),

        gclid: this.optionalString(body.gclid),
        gbraid: this.optionalString(body.gbraid),
        wbraid: this.optionalString(body.wbraid),
        fbclid: this.optionalString(body.fbclid),
        fbc: this.optionalString(body.fbc),
        fbp: this.optionalString(body.fbp),

        matchMethod: "manual",
        matchConfidence: "manual",
      },
    });

    return {
      attribution,
      clickEventMatched: false,
    };
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
