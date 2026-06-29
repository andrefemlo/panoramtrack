import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { EvolutionWebhookService } from "./evolution-webhook.service";

@Controller("webhooks/evolution")
export class EvolutionWebhookController {
  constructor(
    private readonly evolutionWebhookService: EvolutionWebhookService,
  ) {}

  @Post()
  async handleWebhook(
    @Body() body: unknown,
    @Headers("x-webhook-secret") webhookSecret: string | undefined,
  ) {
    this.validateWebhookSecret(webhookSecret);

    return this.evolutionWebhookService.handleWebhook(body);
  }

  @Get("samples")
  async listSamples(
    @Headers("x-webhook-secret") webhookSecret: string | undefined,
    @Query("take") take?: string,
  ) {
    this.validateWebhookSecret(webhookSecret);

    return this.evolutionWebhookService.listPayloadSamples(Number(take) || 20);
  }

  private validateWebhookSecret(webhookSecret: string | undefined) {
    const expectedSecret = process.env.EVOLUTION_WEBHOOK_SECRET;

    if (expectedSecret && webhookSecret !== expectedSecret) {
      throw new UnauthorizedException("Invalid webhook secret");
    }
  }
}
