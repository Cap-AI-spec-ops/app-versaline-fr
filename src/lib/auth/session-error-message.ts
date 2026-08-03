const RELOAD_PAGE_MESSAGE = "Session issue detected. Please reload the page.";

function normalizeMessage(message: string) {
  return message.trim().toLowerCase();
}

export function toSessionAwareErrorMessage(message: string | null | undefined) {
  if (!message) {
    return null;
  }

  const normalized = normalizeMessage(message);

  const looksLikeJwtClockSkew =
    normalized.includes("jwt") &&
    (normalized.includes("future") || normalized.includes("issued") || normalized.includes("iat") || normalized.includes("nbf"));

  if (looksLikeJwtClockSkew) {
    return RELOAD_PAGE_MESSAGE;
  }

  return message;
}

export function withSessionReloadFallback(message: string | null | undefined, fallbackMessage: string) {
  return toSessionAwareErrorMessage(message) ?? fallbackMessage;
}