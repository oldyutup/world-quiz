import { LAYER_FLAG } from "../../../../shared/party-lab/network/protocol";
import { ranksByScore } from "../../../../shared/party-lab/board/rules";
import { GIFT } from "../../../../shared/party-lab/simulation/gifts/config";
import type { GiftEvent } from "../../../../shared/party-lab/simulation/gifts/game";
import type { DecodedGift } from "../../../../shared/party-lab/simulation/gifts/wire";

/** Seconds of play left at round tick `tick`. */
export const giftSecondsLeft = (tick: number) => Math.max(0, GIFT.round.duration - tick / 60);
/** Places per seat (0 best; a player who left is below everyone still in). */
export function giftPlaces(gift: DecodedGift) {
  const ranks = ranksByScore(gift.seats.map((slot) => (gift.flags[slot] & LAYER_FLAG.forfeit ? -1 : Math.max(0, gift.home[slot]))));
  return gift.seats.map((_, seat) => ranks[seat]);
}
/** The big word for this player: their box stolen or knocked off, or theirs the theft / the knock. */
export function giftCallout(events: readonly GiftEvent[], self: number): { id: number; text: string; tone: "bad" | "good" } | null {
  for (let i = events.length - 1; i >= 0 && self >= 0; i--) {
    const e = events[i];
    if (e.kind === "steal" && e.owner === self) return { id: e.id, text: "Kutun çalındı!", tone: "bad" };
    if (e.kind === "knock" && e.actor === self) return { id: e.id, text: "Kutun düştü!", tone: "bad" };
    if (e.kind === "steal" && e.actor === self) return { id: e.id, text: "Çaldın!", tone: "good" };
    if (e.kind === "knock" && e.owner === self) return { id: e.id, text: "Düşürdün!", tone: "good" };
  }
  return null;
}
