import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { HealthController } from "./health.controller";
import { TrackingController } from "./tracking.controller";
import { TrackingService } from "./tracking.service";

@Module({
  controllers: [HealthController, TrackingController],
  providers: [PrismaService, TrackingService],
})
export class AppModule {}
