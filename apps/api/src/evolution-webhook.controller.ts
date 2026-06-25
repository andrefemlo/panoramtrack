import { Body, Controller, Post } from "@nestjs/common";
import { EvolutionWebhookService } from "./evolution-webhook.service";

@Controller("webhooks/evolution")
export class EvolutionWebhookController {
  constructor(
    private readonly evolutionWebhookService: EvolutionWebhookService,
  ) {}

  @Post()
  async handleWebhook(@Body() body: unknown) {
    return this.evolutionWebhookService.handleWebhook(body);
  }
}
