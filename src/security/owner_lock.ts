import type { Context, MiddlewareFn } from "grammy";

export function isOwnerTelegramId(
  fromId: number | undefined,
  ownerId: number,
): boolean {
  return typeof fromId === "number" && fromId === ownerId;
}

export function normalizeWhatsAppNumber(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export function isOwnerWhatsApp(
  fromNumber: string | undefined,
  ownerNumber: string,
): boolean {
  const incoming = normalizeWhatsAppNumber(fromNumber ?? "");
  const owner = normalizeWhatsAppNumber(ownerNumber);
  return incoming.length > 0 && owner.length > 0 && incoming === owner;
}

export function isOwner(params: {
  telegramUserId?: number;
  ownerTelegramId: number;
  whatsappNumber?: string;
  ownerWhatsAppNumber?: string;
}): boolean {
  if (isOwnerTelegramId(params.telegramUserId, params.ownerTelegramId)) {
    return true;
  }
  if (params.ownerWhatsAppNumber) {
    return isOwnerWhatsApp(params.whatsappNumber, params.ownerWhatsAppNumber);
  }
  return false;
}

export function ownerOnly(ownerTelegramId: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (!isOwnerTelegramId(ctx.from?.id, ownerTelegramId)) {
      return;
    }
    await next();
  };
}
