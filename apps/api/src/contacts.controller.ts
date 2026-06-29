import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ContactsService } from "./contacts.service";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  async listContacts(
    @Query("search") search?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("tag") tag?: string,
  ) {
    return this.contactsService.listContacts({
      search,
      take: Number(take) || undefined,
      skip: Number(skip) || undefined,
      tag,
    });
  }

  @Get(":contactId/timeline")
  async getContactTimeline(@Param("contactId") contactId: string) {
    return this.contactsService.getContactTimeline(contactId);
  }

  @Get(":contactId")
  async getContact(@Param("contactId") contactId: string) {
    return this.contactsService.getContact(contactId);
  }

  @Patch(":contactId")
  async updateContact(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
  ) {
    return this.contactsService.updateContact(
      contactId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Post(":contactId/tags")
  async addContactTag(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
  ) {
    return this.contactsService.addContactTag(
      contactId,
      body && typeof body === "object" ? body : {},
    );
  }

  @Delete(":contactId/tags/:tag")
  async removeContactTag(
    @Param("contactId") contactId: string,
    @Param("tag") tag: string,
  ) {
    return this.contactsService.removeContactTag(contactId, tag);
  }

  @Post(":contactId/notes")
  async addContactNote(
    @Param("contactId") contactId: string,
    @Body() body: unknown,
  ) {
    return this.contactsService.addContactNote(
      contactId,
      body && typeof body === "object" ? body : {},
    );
  }
}
