/**
 * Chat auto-follow, independent of React/DOM so it can be tested.
 *
 * The lobby used to keep a "follow" flag that every scroll event rewrote, including
 * events the browser emits on its own (scroll anchoring when the 40-message cap
 * removes the top message). A friend's message could then land below the fold with
 * nothing on screen saying so, until the reader sent a message (the only case that
 * forced a scroll) and both appeared at once. Now: the history disables scroll
 * anchoring, only a reader-initiated scroll can stop following (any scroll that
 * reaches the end resumes it), and unseen incoming messages are counted for a
 * "new messages" button.
 */
export const CHAT_BOTTOM_SLACK_PX = 32;
/** A scroll event this soon after wheel/touch/key/pointer input is the reader's. */
export const CHAT_INTENT_MS = 1000;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}
export interface FollowMessage {
  id: string;
  playerId: string;
}
export interface ChatFollowState {
  following: boolean;
  unread: number;
  lastId: string;
}

export const isAtBottom = (box: ScrollMetrics, slack = CHAT_BOTTOM_SLACK_PX) =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= slack;

export const initialChatFollow = (): ChatFollowState => ({
  following: true,
  unread: 0,
  lastId: "",
});

/** A committed message list. `pin` means: scroll the history to its end now. */
export function followMessages(
  state: ChatFollowState,
  messages: readonly FollowMessage[],
  selfId: string
): { state: ChatFollowState; pin: boolean } {
  const last = messages[messages.length - 1];
  if (!last || last.id === state.lastId) return { state, pin: false };
  const seen = messages.findIndex((m) => m.id === state.lastId);
  // The bounded history may already have dropped lastId; then every entry is new.
  const fresh = seen < 0 ? messages : messages.slice(seen + 1);
  if (state.following || fresh.some((m) => m.playerId === selfId))
    return { state: { following: true, unread: 0, lastId: last.id }, pin: true };
  return {
    state: {
      following: false,
      unread: state.unread + fresh.filter((m) => m.playerId !== selfId).length,
      lastId: last.id,
    },
    pin: false,
  };
}

/**
 * A scroll event: reaching the end resumes following and clears unread. Leaving the
 * end stops following only when the reader caused it; programmatic or layout-driven
 * scrolls (anchoring, clamping) never hide new messages.
 */
export function followScroll(
  state: ChatFollowState,
  box: ScrollMetrics,
  byReader: boolean
): ChatFollowState {
  if (isAtBottom(box)) return { ...state, following: true, unread: 0 };
  return state.following && byReader ? { ...state, following: false } : state;
}

export const jumpToLatest = (state: ChatFollowState): ChatFollowState => ({
  ...state,
  following: true,
  unread: 0,
});
