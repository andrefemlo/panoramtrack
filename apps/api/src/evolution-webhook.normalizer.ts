export type EvolutionMessageKind =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "unknown";

export type NormalizedEvolutionWebhook = {
  event: string;
  instanceName: string;
  instancePhone: string | null;
  externalChatId: string | null;
  leadPhone: string | null;
  externalMessageId: string | null;
  fromMe: boolean;
  sentAt: Date;
  pushName: string | null;
  messageType: EvolutionMessageKind;
  body: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  needsMediaHydration: boolean;
  rawPayload: any;
};

const MEDIA_CHILDREN = [
  "imageMessage",
  "audioMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
] as const;

export function normalizeEvolutionWebhook(
  payload: unknown,
  eventFromPath?: string | null,
): NormalizedEvolutionWebhook {
  const raw = payload as any;
  const data = raw?.data || raw || {};
  const messageNode = unwrapMessageNode(extractMessageNode(raw));
  const messageType = extractMessageType(raw, messageNode);
  const mediaNode = mediaNodeForType(messageNode, messageType);

  const mediaMimeType = normalizeMimeType(
    optionalString(
      mediaNode?.mimetype ||
        data?.mimetype ||
        data?.mimeType ||
        raw?.mimetype ||
        raw?.mimeType,
    ),
    messageType,
  );

  const rawBase64 = extractRawBase64({
    raw,
    data,
    messageNode,
    mediaNode,
  });

  const base64DataUrl = rawBase64
    ? toDataUrl(rawBase64, mediaMimeType, messageType)
    : null;

  const fallbackMediaUrl =
    optionalString(
      data?.mediaUrl ||
        raw?.mediaUrl ||
        data?.url ||
        raw?.url ||
        mediaNode?.url ||
        mediaNode?.URL,
    ) || null;

  const finalMediaUrl = base64DataUrl || fallbackMediaUrl;

  return {
    event: normalizeEventName(raw?.event || data?.event || eventFromPath),
    instanceName: extractInstanceName(raw),
    instancePhone: extractInstancePhone(raw),
    externalChatId: extractChatId(raw),
    leadPhone: extractLeadPhone(raw),
    externalMessageId: extractMessageId(raw),
    fromMe: extractFromMe(raw),
    sentAt: extractSentAt(raw),
    pushName: extractPushName(raw),
    messageType,
    body: extractMessageText(raw, messageNode),
    mediaUrl: finalMediaUrl,
    mediaMimeType,
    mediaFileName:
      optionalString(
        mediaNode?.fileName ||
          mediaNode?.filename ||
          data?.fileName ||
          data?.filename ||
          raw?.fileName ||
          raw?.filename,
      ) || null,
    needsMediaHydration: shouldHydrateMedia(finalMediaUrl, messageType),
    rawPayload: raw,
  };
}

export function isMessageEvent(event: string): boolean {
  return [
    "MESSAGES_UPSERT",
    "SEND_MESSAGE",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
  ].includes(event);
}

export function isContactEvent(event: string): boolean {
  return ["CONTACTS_SET", "CONTACTS_UPSERT", "CONTACTS_UPDATE"].includes(event);
}

export function isChatEvent(event: string): boolean {
  return ["CHATS_SET", "CHATS_UPSERT", "CHATS_UPDATE"].includes(event);
}

export function isIndividualContactChat(chatId: string | null): boolean {
  if (!chatId) {
    return false;
  }

  const normalized = chatId.toLowerCase();

  if (normalized === "status@broadcast") return false;
  if (normalized.endsWith("@g.us")) return false;
  if (normalized.endsWith("@newsletter")) return false;
  if (normalized.endsWith("@broadcast")) return false;

  return normalized.endsWith("@s.whatsapp.net");
}

function normalizeEventName(value: unknown): string {
  const raw = optionalString(value) || "UNKNOWN";

  return raw.replace(/-/g, "_").replace(/\./g, "_").toUpperCase();
}

function extractInstanceName(payload: any): string {
  return (
    optionalString(
      payload?.instance ||
        payload?.instanceName ||
        payload?.data?.instance ||
        payload?.data?.instanceName,
    ) || "default"
  );
}

function extractInstancePhone(payload: any): string | null {
  const value =
    optionalString(
      payload?.instancePhone ||
        payload?.data?.instancePhone ||
        payload?.owner ||
        payload?.data?.owner ||
        payload?.sender ||
        payload?.data?.sender,
    ) || null;

  if (!value) {
    return null;
  }

  const normalized = value.split("@")[0].replace(/\D/g, "");

  return normalized || null;
}

function extractChatId(payload: any): string | null {
  return (
    optionalString(
      payload?.data?.key?.remoteJid ||
        payload?.key?.remoteJid ||
        payload?.data?.remoteJid ||
        payload?.remoteJid ||
        payload?.data?.id,
    ) || null
  );
}

function extractLeadPhone(payload: any): string | null {
  const chatId = extractChatId(payload);

  if (!chatId) {
    return null;
  }

  const raw = chatId.split("@")[0];
  const phone = raw.replace(/\D/g, "");

  if (phone.length < 8) {
    return null;
  }

  return phone;
}

function extractMessageId(payload: any): string | null {
  return (
    optionalString(
      payload?.data?.key?.id ||
        payload?.key?.id ||
        payload?.data?.messageId ||
        payload?.messageId ||
        payload?.id,
    ) || null
  );
}

function extractFromMe(payload: any): boolean {
  return Boolean(
    payload?.data?.key?.fromMe ||
    payload?.key?.fromMe ||
    payload?.data?.fromMe ||
    payload?.fromMe,
  );
}

function extractPushName(payload: any): string | null {
  return (
    optionalString(
      payload?.data?.pushName ||
        payload?.pushName ||
        payload?.data?.name ||
        payload?.name ||
        payload?.data?.notify ||
        payload?.notify ||
        payload?.contact?.name,
    ) || null
  );
}

function extractMessageNode(payload: any): any {
  return (
    payload?.data?.message?.message ||
    payload?.data?.message ||
    payload?.message?.message ||
    payload?.message ||
    payload?.content ||
    {}
  );
}

function unwrapMessageNode(node: any): any {
  let current = node || {};

  for (let index = 0; index < 8; index += 1) {
    const next =
      current?.ephemeralMessage?.message ||
      current?.viewOnceMessage?.message ||
      current?.viewOnceMessageV2?.message ||
      current?.viewOnceMessageV2Extension?.message ||
      current?.documentWithCaptionMessage?.message ||
      current?.editedMessage?.message ||
      current?.albumMessage?.message;

    if (!next || next === current) {
      return current;
    }

    current = next;
  }

  return current;
}

function extractMessageType(
  payload: any,
  messageNode: any,
): EvolutionMessageKind {
  const explicit = optionalString(
    payload?.data?.messageType || payload?.messageType || payload?.type,
  )?.toLowerCase();

  if (explicit) {
    if (explicit.includes("image")) return "image";
    if (explicit.includes("audio")) return "audio";
    if (explicit.includes("video")) return "video";
    if (explicit.includes("document")) return "document";
    if (explicit.includes("sticker")) return "sticker";
    if (explicit.includes("conversation") || explicit.includes("text")) {
      return "text";
    }
  }

  if (messageNode?.imageMessage) return "image";
  if (messageNode?.audioMessage) return "audio";
  if (messageNode?.videoMessage) return "video";
  if (messageNode?.documentMessage) return "document";
  if (messageNode?.stickerMessage) return "sticker";

  if (payload?.data?.message?.imageMessage) return "image";
  if (payload?.data?.message?.audioMessage) return "audio";
  if (payload?.data?.message?.videoMessage) return "video";
  if (payload?.data?.message?.documentMessage) return "document";
  if (payload?.data?.message?.stickerMessage) return "sticker";

  if (
    messageNode?.conversation ||
    messageNode?.extendedTextMessage?.text ||
    messageNode?.buttonsResponseMessage ||
    messageNode?.listResponseMessage
  ) {
    return "text";
  }

  return "unknown";
}

function mediaNodeForType(
  messageNode: any,
  messageType: EvolutionMessageKind,
): any {
  if (messageType === "image") return messageNode?.imageMessage;
  if (messageType === "audio") return messageNode?.audioMessage;
  if (messageType === "video") return messageNode?.videoMessage;
  if (messageType === "document") return messageNode?.documentMessage;
  if (messageType === "sticker") return messageNode?.stickerMessage;

  for (const child of MEDIA_CHILDREN) {
    if (messageNode?.[child]) {
      return messageNode[child];
    }
  }

  return null;
}

function extractMessageText(payload: any, messageNode: any): string | null {
  return (
    optionalString(
      messageNode?.conversation ||
        messageNode?.extendedTextMessage?.text ||
        messageNode?.imageMessage?.caption ||
        messageNode?.videoMessage?.caption ||
        messageNode?.documentMessage?.caption ||
        payload?.data?.message?.imageMessage?.caption ||
        payload?.data?.message?.videoMessage?.caption ||
        payload?.data?.message?.documentMessage?.caption ||
        payload?.data?.message?.message?.imageMessage?.caption ||
        payload?.data?.message?.message?.videoMessage?.caption ||
        payload?.data?.message?.message?.documentMessage?.caption ||
        payload?.data?.caption ||
        payload?.caption ||
        payload?.data?.text ||
        payload?.data?.body ||
        payload?.text ||
        payload?.body,
    ) || null
  );
}

function extractSentAt(payload: any): Date {
  const timestamp =
    payload?.data?.messageTimestamp ||
    payload?.messageTimestamp ||
    payload?.data?.timestamp ||
    payload?.timestamp;

  if (typeof timestamp === "number") {
    return new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
  }

  if (typeof timestamp === "string" && /^\d+$/.test(timestamp)) {
    const parsed = Number(timestamp);

    return new Date(parsed > 9999999999 ? parsed : parsed * 1000);
  }

  if (typeof payload?.date_time === "string") {
    const parsed = new Date(payload.date_time);

    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function extractRawBase64(params: {
  raw: any;
  data: any;
  messageNode: any;
  mediaNode: any;
}): string | null {
  const candidates = [
    params.data?.message?.base64,
    params.messageNode?.base64,
    params.mediaNode?.base64,

    params.data?.base64,
    params.raw?.base64,

    params.data?.media,
    params.data?.mediaBase64,
    params.raw?.media,
    params.raw?.mediaBase64,

    params.data?.message?.media,
    params.data?.message?.mediaBase64,

    params.data?.message?.imageMessage?.base64,
    params.data?.message?.audioMessage?.base64,
    params.data?.message?.videoMessage?.base64,
    params.data?.message?.documentMessage?.base64,
    params.data?.message?.stickerMessage?.base64,
  ];

  for (const candidate of candidates) {
    const value = optionalString(candidate);

    if (value) {
      return value;
    }
  }

  return null;
}

function toDataUrl(
  rawBase64: string,
  mimeType: string | null,
  messageType: EvolutionMessageKind,
): string {
  if (rawBase64.startsWith("data:")) {
    return rawBase64
      .replace("data:audio/ogg; codecs=opus;base64,", "data:audio/ogg;base64,")
      .replace("data:audio/ogg;codecs=opus;base64,", "data:audio/ogg;base64,");
  }

  return `data:${normalizeMimeType(mimeType, messageType) || "application/octet-stream"};base64,${rawBase64}`;
}

function normalizeMimeType(
  value: string | null,
  messageType?: EvolutionMessageKind,
): string | null {
  const normalized = value?.toLowerCase().trim();

  if (normalized) {
    if (normalized.includes("audio/ogg") || normalized.includes("opus")) {
      return "audio/ogg";
    }

    return normalized.split(";")[0].trim() || null;
  }

  if (messageType === "image") return "image/jpeg";
  if (messageType === "audio") return "audio/ogg";
  if (messageType === "sticker") return "image/webp";
  if (messageType === "video") return "video/mp4";
  if (messageType === "document") return "application/octet-stream";

  return null;
}

function shouldHydrateMedia(
  mediaUrl: string | null,
  messageType: EvolutionMessageKind,
): boolean {
  if (
    !["image", "audio", "video", "document", "sticker"].includes(messageType)
  ) {
    return false;
  }

  if (!mediaUrl) {
    return true;
  }

  if (mediaUrl.startsWith("data:")) {
    return false;
  }

  return (
    mediaUrl.includes("mmg.whatsapp.net") ||
    mediaUrl.includes("a.whatsapp.net") ||
    mediaUrl.includes(".enc")
  );
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed || null;
}
