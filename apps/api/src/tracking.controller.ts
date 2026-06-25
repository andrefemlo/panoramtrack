import { Controller, Get, Param, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { TrackingService } from "./tracking.service";

@Controller()
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get("r/:slug")
  async redirectToWhatsapp(
    @Param("slug") slug: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const redirectUrl =
      await this.trackingService.createClickAndBuildRedirectUrl(
        slug,
        query,
        req,
      );

    return res.redirect(302, redirectUrl);
  }
}
