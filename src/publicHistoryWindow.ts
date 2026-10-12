import type { ChatMessage, HistoryPage } from "../shared/types";
import { encodeHistoryCursor } from "../shared/historyCursor";

export const CLIENT_CHANNEL_MESSAGE_LIMIT = 600;
const PENDING_LIVE_LIMIT = 80;
type PageInfo = Pick<HistoryPage, "before" | "hasMore">;

export interface PublicHistoryWindow {
  messages: ChatMessage[];
  pages: Record<string, PageInfo>;
  /** A historical window must never be silently spliced onto a newer live tail. */
  detached: Record<string, boolean>;
  pendingLive: Record<string, ChatMessage[]>;
}

export type PublicHistoryAction =
  | { type: "snapshot"; messages: ChatMessage[]; pages?: Record<string, PageInfo> }
  | { type: "live"; message: ChatMessage; preserveWindow?: boolean }
  | { type: "pause"; channelId: string }
  | { type: "older" | "latest"; page: HistoryPage }
  | { type: "transform"; update: (messages: ChatMessage[]) => ChatMessage[] }
  | { type: "remove-page"; channelId: string };

export const emptyPublicHistory = (): PublicHistoryWindow => ({
  messages: [], pages: {}, detached: {}, pendingLive: {},
});

export const compareMessages = (a: ChatMessage, b: ChatMessage): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const uniqueSorted = (messages: ChatMessage[]): ChatMessage[] =>
  [...new Map(messages.map((message) => [message.id, message])).values()].sort(compareMessages);

const replaceChannel = (messages: ChatMessage[], channelId: string, rows: ChatMessage[]): ChatMessage[] =>
  [...messages.filter((message) => message.channelId !== channelId), ...rows].sort(compareMessages);

export const reducePublicHistory = (state: PublicHistoryWindow, action: PublicHistoryAction): PublicHistoryWindow => {
  if (action.type === "snapshot") {
    const channelIds = [...new Set(action.messages.map((message) => message.channelId))];
    const pages = { ...action.pages };
    const messages = channelIds.flatMap((channelId) => {
      const all = uniqueSorted(action.messages.filter((message) => message.channelId === channelId));
      const rows = all.slice(-CLIENT_CHANNEL_MESSAGE_LIMIT);
      if (all.length > rows.length) pages[channelId] = { before: encodeHistoryCursor(rows[0]!), hasMore: true };
      return rows;
    }).sort(compareMessages);
    return { messages, pages, detached: {}, pendingLive: {} };
  }
  if (action.type === "transform") return {
    ...state,
    messages: action.update(state.messages),
    pendingLive: Object.fromEntries(Object.entries(state.pendingLive).map(([id, rows]) => [id, action.update(rows)])),
  };
  if (action.type === "remove-page") {
    const pages = { ...state.pages };
    const detached = { ...state.detached };
    const pendingLive = { ...state.pendingLive };
    delete pages[action.channelId];
    delete detached[action.channelId];
    delete pendingLive[action.channelId];
    return { ...state, pages, detached, pendingLive };
  }
  if (action.type === "pause") return { ...state, detached: { ...state.detached, [action.channelId]: true } };

  const channelId = action.type === "live" ? action.message.channelId : action.page.channelId;
  const current = state.messages.filter((message) => message.channelId === channelId);
  if (action.type === "live") {
    if (current.some((message) => message.id === action.message.id)) return state;
    if (state.detached[channelId] || (action.preserveWindow && current.length >= CLIENT_CHANNEL_MESSAGE_LIMIT)) {
      return {
        ...state,
        detached: { ...state.detached, [channelId]: true },
        pendingLive: {
          ...state.pendingLive,
          [channelId]: uniqueSorted([...(state.pendingLive[channelId] ?? []), action.message]).slice(-PENDING_LIVE_LIMIT),
        },
      };
    }
    const all = uniqueSorted([...current, action.message]);
    const rows = all.slice(-CLIENT_CHANNEL_MESSAGE_LIMIT);
    return {
      ...state,
      messages: replaceChannel(state.messages, channelId, rows),
      pages: all.length > rows.length
        ? { ...state.pages, [channelId]: { before: encodeHistoryCursor(rows[0]!), hasMore: true } }
        : state.pages,
    };
  }

  const page = action.page;
  const sortedPage = uniqueSorted(page.messages.filter((message) => message.channelId === channelId));
  const pending = state.pendingLive[channelId] ?? [];
  // If more than a full pending buffer arrived during a slow latest-page read,
  // its fresh tail is safer than displaying a disconnected older response.
  const pendingSupersedesPage = action.type === "latest" && pending.length >= PENDING_LIVE_LIMIT &&
    sortedPage.at(-1) && compareMessages(pending[0]!, sortedPage.at(-1)!) > 0;
  // Only a contiguous window is rendered. Older paging retains the older edge;
  // returning live replaces it with a fresh server page and concurrent events.
  const all = action.type === "older"
    ? uniqueSorted([...sortedPage, ...current])
    : uniqueSorted([
      ...(pendingSupersedesPage ? [] : sortedPage),
      ...pending.filter((message) => !sortedPage[0] || compareMessages(message, sortedPage[0]) >= 0),
    ]);
  const rows = action.type === "older"
    ? all.slice(0, CLIENT_CHANNEL_MESSAGE_LIMIT)
    : all.slice(-CLIENT_CHANNEL_MESSAGE_LIMIT);
  const pendingLive = { ...state.pendingLive };
  if (action.type === "latest") delete pendingLive[channelId];
  return {
    ...state,
    messages: replaceChannel(state.messages, channelId, rows),
    pages: { ...state.pages, [channelId]: {
      hasMore: page.hasMore || Boolean(pendingSupersedesPage) || (action.type === "latest" && all.length > rows.length),
      ...(rows[0] ? { before: encodeHistoryCursor(rows[0]) } : {}),
    } },
    detached: { ...state.detached, [channelId]: action.type === "older" },
    pendingLive,
  };
};
