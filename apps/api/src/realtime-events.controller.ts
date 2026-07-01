import { Controller, Sse } from "@nestjs/common";
import { map } from "rxjs/operators";
import { RealtimeEventsService } from "./realtime-events.service";

@Controller("conversations")
export class RealtimeEventsController {
  constructor(private readonly realtimeEvents: RealtimeEventsService) {}

  @Sse("events")
  events() {
    return this.realtimeEvents.events$.pipe(
      map((event) => ({
        type: event.type,
        data: event,
      })),
    );
  }
}
