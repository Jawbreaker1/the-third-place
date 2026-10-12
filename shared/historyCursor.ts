import type { ChatMessage } from "./types.js";

/** Versioned wire cursor shared by the server and the browser's moving window. */
export const encodeHistoryCursor = (message: Pick<ChatMessage, "createdAt" | "id">): string => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, createdAt: message.createdAt, id: message.id }));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
