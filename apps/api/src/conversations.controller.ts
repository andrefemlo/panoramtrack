import { Body, Controller, Param, Post } from "@nestjs/common";
import { ConversationsService } from "./conversations.service";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post("leads/:leadId/messages/text")
  async sendTextMessage(
    @Param("leadId") leadId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.sendTextMessage(
      leadId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Post("leads/:leadId/messages/media")
  async sendMediaMessage(
    @Param("leadId") leadId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.sendMediaMessage(
      leadId,
      body && typeof body === "object" ? body : {},
    );
  }
}
