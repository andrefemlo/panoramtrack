import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { LeadsService } from "./leads.service";

@Controller("leads")
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  async listLeads(
    @Query("stage") stage?: string,
    @Query("search") search?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    return this.leadsService.listLeads({
      stage,
      search,
      take: Number(take) || undefined,
      skip: Number(skip) || undefined,
    });
  }

  @Get(":id/attribution-candidates")
  async listAttributionCandidates(
    @Param("id") id: string,
    @Query("search") search?: string,
    @Query("take") take?: string,
    @Query("sinceHours") sinceHours?: string,
  ) {
    return this.leadsService.listAttributionCandidates(id, {
      search,
      take: Number(take) || undefined,
      sinceHours: Number(sinceHours) || undefined,
    });
  }

  @Get(":id")
  async getLead(@Param("id") id: string) {
    return this.leadsService.getLead(id);
  }

  @Post(":id/attributions/manual")
  async createManualAttribution(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.leadsService.createManualAttribution(
      id,
      body && typeof body === "object" ? body : {},
    );
  }

  @Patch(":id/attributions/:attributionId")
  async updateAttribution(
    @Param("id") id: string,
    @Param("attributionId") attributionId: string,
    @Body() body: unknown,
  ) {
    return this.leadsService.updateAttribution(
      id,
      attributionId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Patch(":id/stage")
  async updateLeadStage(@Param("id") id: string, @Body() body: unknown) {
    return this.leadsService.updateLeadStage(
      id,
      body && typeof body === "object" ? body : {},
    );
  }
}
