import { Injectable } from "@nestjs/common";
import { Subject } from "rxjs";

export type RealtimeEvent = {
  type: "conversation.updated" | "message.created";
  conversationId: string;
  leadId?: string | null;
  messageId?: string | null;
  sentAt?: string | null;
};

@Injectable()
export class RealtimeEventsService {
  private readonly eventsSubject = new Subject<RealtimeEvent>();

  readonly events$ = this.eventsSubject.asObservable();

  emit(event: RealtimeEvent) {
    this.eventsSubject.next(event);
  }
}
