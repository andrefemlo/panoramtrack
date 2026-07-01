import { Controller, Sse } from "@nestjs/common";
import { map } from "rxjs/operators";
import { RealtimeEventsService } from "./realtime-events.service";

@Controller("realtime")
export class RealtimeEventsController {
  constructor(private readonly realtimeEvents: RealtimeEventsService) {}

  @Sse("conversations")
  conversations() {
    return this.realtimeEvents.events$.pipe(
      map((event) => ({
        type: event.type,
        data: event,
      })),
    );
  }
}
