import type { GameMode } from "../../../shared/party-lab/modes";
import type { ChatMessage, LobbyPlayer } from "../network/types";

/*
 * In-game chat over the online arenas and the board: the lobby's own channel (the same
 * messages, the same server length and rate limits), shown as a few lines in the
 * bottom-left corner. While it is open it holds this player's input exactly like the Esc
 * menu does (see useArenaMenu's `chatOpen`): keys released, a neutral input sent, the
 * pointer lock given up. The match goes on.
 */

/** Lines shown at once, open or closed (short landscape screens hide the oldest two in CSS). */
export const CHAT_LINES = 5;
/** A line stays this long after it arrives, then fades out unless the chat is open. */
export const CHAT_SHOW_MS = 8000;
/** A notice from the server (rate limit, invalid text) stays this long. */
export const CHAT_NOTICE_MS = 5000;
/** A name colour for a sender who has left the room (slot colours are light, so is this). */
export const CHAT_LEFT_COLOR = "#c9c4b6";

/**
 * When each message was first seen on this page. The history already there when the room
 * was joined counts as old (it never pops up); a message sent in the lobby just before a
 * round starts is still fresh when the arena opens. `synced` is false until the room's
 * first state has arrived (the code is known before the history is).
 */
export class ChatArrivals {
  private seen = new Map<string, number>();
  private primed = false;
  observe(messages: readonly Pick<ChatMessage, "id">[], now: number, synced = true) {
    if (!synced) return;
    const next = new Map<string, number>();
    for (const message of messages) next.set(message.id, this.seen.get(message.id) ?? (this.primed ? now : -Infinity));
    this.seen = next;
    this.primed = true;
  }
  at(id: string) {
    return this.seen.get(id) ?? -Infinity;
  }
}

export interface ChatLine {
  id: string;
  name: string;
  /** The sender's slot colour. */
  color: string;
  text: string;
  self: boolean;
  /** Visible now; a line that stops being shown fades out (CSS). */
  shown: boolean;
}

export function chatLines(
  messages: readonly ChatMessage[],
  players: readonly LobbyPlayer[],
  selfId: string,
  arrivedAt: (id: string) => number,
  now: number,
  open: boolean,
  count = CHAT_LINES
): ChatLine[] {
  return messages.slice(-count).map((message) => ({
    id: message.id,
    name: message.nickname,
    color: players.find((p) => p.id === message.playerId)?.color ?? CHAT_LEFT_COLOR,
    text: message.text,
    self: message.playerId === selfId,
    shown: open || now - arrivedAt(message.id) < CHAT_SHOW_MS,
  }));
}

/** Milliseconds until the next shown line should fade, or null when none will. */
export function nextFade(lines: readonly ChatLine[], arrivedAt: (id: string) => number, now: number, open: boolean): number | null {
  if (open) return null;
  let wait: number | null = null;
  for (const line of lines) {
    if (!line.shown) continue;
    const left = arrivedAt(line.id) + CHAT_SHOW_MS - now;
    if (wait === null || left < wait) wait = Math.max(0, left);
  }
  return wait;
}

export interface ChatKey {
  key: string;
  repeat: boolean;
  isComposing: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * A window keydown opens the chat: a plain Enter that is not meant for a control (a focused
 * button or field keeps its own Enter). The Esc menu being open is the caller's check.
 */
export const opensChat = (event: ChatKey, onControl: boolean) =>
  event.key === "Enter" && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !onControl;

/** Where the chat sits: a mode's arena, or the board between mini games. */
export type ChatPlace = GameMode | "board_game";
export type ChatScreen = "wide" | "narrow" | "short" | "phone";
/**
 * Bottom: px from the bottom of the page to the chat's bottom edge. Width: the chat's column.
 * Left: when the arena's whole left side is HUD (short screens only). Quiet: the closed chat
 * shows only its button there (the open chat still shows the recent lines).
 */
export interface ChatSpot {
  bottom: number;
  width?: number;
  left?: number;
  quiet?: boolean;
}
export const CHAT_WIDTH: Readonly<Record<ChatScreen, number>> = { wide: 360, narrow: 360, short: 360, phone: 260 };
export const CHAT_LEFT: Readonly<Record<ChatScreen, number>> = { wide: 24, narrow: 24, short: 24, phone: 16 };
const at = (bottom: number, width?: number): ChatSpot => (width ? { bottom, width } : { bottom });

/**
 * The chat's place per arena and screen class: wide > 900 px; narrow ≤ 900 px; short ≤ 500 px
 * high (a landscape phone; `narrow` unless given); phone ≤ 600 px wide. Each spot keeps the
 * chat on the left and clear of that arena's lasting HUD: above a bottom-left panel (barn
 * health, snowball pocket, bowling charge, scores), or narrower than a bottom-centre one
 * (console, controls bar, look prompt). Measured in a headed browser at 1280×800, 860×600,
 * 390×844 and 844×390. Passing HUD is handled in CSS (the first seconds' controls hint, status
 * chips, the board's own turn buttons, bowling callouts). A Record, so a new mode cannot
 * compile without choosing its spots.
 */
export const CHAT_LAYOUT: Readonly<Record<ChatPlace, { wide: ChatSpot; narrow: ChatSpot; short?: ChatSpot; phone: ChatSpot }>> = {
  rooftop_brawl: { wide: at(24), narrow: at(24), phone: at(24) },
  barn_shootout: { wide: at(132), narrow: at(132, 240), phone: at(132) },
  layer_chaos: { wide: at(24), narrow: at(24, 190), phone: at(24) },
  color_chaos: { wide: at(24), narrow: at(24, 190), phone: at(24) },
  bomb_tag: { wide: at(24), narrow: at(24, 190), phone: at(24) },
  prop_hunt: { wide: at(24), narrow: at(24, 190), phone: at(146) },
  // Short: the charge panel (bottom) and the scores (top) fill the left; between the panel
  // and the driving help.
  human_bowling: { wide: at(288), narrow: at(250), short: { bottom: 24, left: 262, width: 210 }, phone: at(370) },
  snowball_brawl: { wide: at(24), narrow: at(24), phone: at(160) },
  crate_rain: { wide: at(82), narrow: at(82, 240), phone: at(160) },
  // Phone: narrow enough to stay off the crosshair. Short: pocket, scores, prompt and crosshair
  // leave no room for lines (the mode needs a mouse anyway).
  snowball_fight: { wide: at(226), narrow: at(210), short: { bottom: 24, quiet: true }, phone: at(298, 170) },
  kart_race: { wide: at(100), narrow: at(24, 185), phone: at(120) },
  classic_bowling: { wide: at(24), narrow: at(24, 200), phone: at(218) },
  click_race: { wide: at(24), narrow: at(24, 260), phone: at(64) },
  gold_miner: { wide: at(24), narrow: at(24, 260), phone: at(64) },
  board_game: { wide: at(24), narrow: at(24, 260), phone: at(24) },
};

/** CSS variables for one place: --pl-chat-{bottom,width,left,lines,lines-wait}-{screen}. */
export function chatLayoutVars(place: ChatPlace): Record<string, string> {
  const layout = CHAT_LAYOUT[place];
  const vars: Record<string, string> = {};
  for (const screen of ["wide", "narrow", "short", "phone"] as const) {
    const spot = (screen === "short" ? layout.short ?? layout.narrow : layout[screen]);
    vars[`--pl-chat-bottom-${screen}`] = `${spot.bottom}px`;
    vars[`--pl-chat-width-${screen}`] = `${spot.width ?? CHAT_WIDTH[screen]}px`;
    vars[`--pl-chat-left-${screen}`] = `${spot.left ?? CHAT_LEFT[screen]}px`;
    vars[`--pl-chat-lines-${screen}`] = spot.quiet ? "hidden" : "visible";
    // Lines come back late (after a passing HUD has faded) but go at once.
    vars[`--pl-chat-lines-wait-${screen}`] = spot.quiet ? "0s" : "0.75s";
  }
  return vars;
}
