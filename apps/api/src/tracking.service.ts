import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "./prisma.service";

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async createClickAndBuildRedirectUrl(
    slug: string,
    query: Record<string, unknown>,
    req: Request,
  ): Promise<string> {
    const trackingLink = await this.prisma.trackingLink.findUnique({
      where: { slug },
      include: { client: true },
    });

    if (!trackingLink || !trackingLink.isActive) {
      throw new NotFoundException("Tracking link not found");
    }

    const clickCode = this.generateClickCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    const ipHash = this.hashIp(this.getIp(req));

    await this.prisma.clickEvent.create({
      data: {
        clientId: trackingLink.clientId,
        trackingLinkId: trackingLink.id,
        clickCode,
        destinationWhatsappPhone: trackingLink.whatsappPhone,

        utmSource: this.getQueryParam(query, "utm_source"),
        utmMedium: this.getQueryParam(query, "utm_medium"),
        utmCampaign: this.getQueryParam(query, "utm_campaign"),
        utmContent: this.getQueryParam(query, "utm_content"),
        utmTerm: this.getQueryParam(query, "utm_term"),

        gclid: this.getQueryParam(query, "gclid"),
        gbraid: this.getQueryParam(query, "gbraid"),
        wbraid: this.getQueryParam(query, "wbraid"),
        fbclid: this.getQueryParam(query, "fbclid"),
        fbc: this.getQueryParam(query, "fbc"),
        fbp: this.getQueryParam(query, "fbp"),

        ipHash,
        userAgent: req.headers["user-agent"] || null,
        referrer:
          req.headers.referer || req.headers.referrer?.toString() || null,

        clickedAt: now,
        expiresAt,
      },
    });

    const message = this.buildWhatsappMessage(
      trackingLink.whatsappInitialMessage,
      clickCode,
    );

    return this.buildWhatsappUrl(trackingLink.whatsappPhone, message);
  }

  private buildWhatsappMessage(baseMessage: string, clickCode: string): string {
    const cleanMessage = baseMessage.trim();

    if (cleanMessage.toLowerCase().includes("ref:")) {
      return cleanMessage;
    }

    return `${cleanMessage} Ref: ${clickCode}`;
  }

  private buildWhatsappUrl(phone: string, message: string): string {
    const normalizedPhone = phone.replace(/\D/g, "");
    const encodedMessage = encodeURIComponent(message);

    return `https://wa.me/${normalizedPhone}?text=${encodedMessage}`;
  }

  private generateClickCode(): string {
    return randomBytes(4).toString("hex").toUpperCase();
  }

  private getQueryParam(
    query: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = query[key];

    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === "string" ? first : null;
    }

    return typeof value === "string" ? value : null;
  }

  private getIp(req: Request): string | null {
    const forwardedFor = req.headers["x-forwarded-for"];

    if (typeof forwardedFor === "string") {
      return forwardedFor.split(",")[0]?.trim() || null;
    }

    return req.socket.remoteAddress || null;
  }

  private hashIp(ip: string | null): string | null {
    if (!ip) return null;

    const salt = process.env.IP_HASH_SALT || "change-this-salt";

    return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
  }
}
