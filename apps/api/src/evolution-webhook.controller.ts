import {
  Body,
  Controller,
  Headers,
  Post,
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
    const expectedSecret = process.env.EVOLUTION_WEBHOOK_SECRET;

    if (expectedSecret && webhookSecret !== expectedSecret) {
      throw new UnauthorizedException("Invalid webhook secret");
    }

    return this.evolutionWebhookService.handleWebhook(body);
  }
}
