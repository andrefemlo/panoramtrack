import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ConversationsService } from "./conversations.service";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  async listConversations(
    @Query("search") search?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("instanceName") instanceName?: string,
    @Query("status") status?: string,
    @Query("archived") archived?: string,
  ) {
    return this.conversationsService.listConversations({
      search,
      take: Number(take) || undefined,
      skip: Number(skip) || undefined,
      instanceName,
      status,
      archived,
    });
  }

  @Get(":conversationId/messages")
  async listConversationMessages(
    @Param("conversationId") conversationId: string,
    @Query("take") take?: string,
    @Query("before") before?: string,
  ) {
    return this.conversationsService.listConversationMessages(conversationId, {
      take: Number(take) || undefined,
      before,
    });
  }

  @Get(":conversationId")
  async getConversation(@Param("conversationId") conversationId: string) {
    return this.conversationsService.getConversation(conversationId);
  }

  @Patch(":conversationId/read")
  async markAsRead(@Param("conversationId") conversationId: string) {
    return this.conversationsService.markConversationAsRead(conversationId);
  }

  @Patch(":conversationId/archive")
  async archiveConversation(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.archiveConversation(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Patch(":conversationId/pin")
  async pinConversation(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.pinConversation(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Patch(":conversationId/status")
  async updateConversationStatus(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.updateConversationStatus(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Patch(":conversationId/assignee")
  async assignConversation(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.assignConversation(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Post(":conversationId/messages/text")
  async sendConversationTextMessage(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.sendConversationTextMessage(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Post(":conversationId/messages/media")
  async sendConversationMediaMessage(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversationsService.sendConversationMediaMessage(
      conversationId,
      body && typeof body === "object" ? body : {},
    );
  }

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
