import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
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

  @Get(":id")
  async getLead(@Param("id") id: string) {
    return this.leadsService.getLead(id);
  }

  @Patch(":id/stage")
  async updateLeadStage(@Param("id") id: string, @Body() body: unknown) {
    return this.leadsService.updateLeadStage(
      id,
      body && typeof body === "object" ? body : {},
    );
  }
}
