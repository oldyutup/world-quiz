import type { WinnerChoice } from "../../../../shared/party-lab/board/rules";
import type { BoardRoll, BoardWire } from "../../../../shared/party-lab/board/wire";
import { MODE_NAMES } from "../../../../shared/party-lab/modes";

export const CHOICE_LABELS: Record<WinnerChoice, string> = { two: "🎲🎲 İki zar", plus: "🎲 +1" };

/** "4 ve 2 → 4", "3 + 1 → 4", "5". */
export function rollText(roll: BoardRoll) {
  if (roll.kind === "two") return `${roll.dice[0]} ve ${roll.dice[1]} → ${roll.value}`;
  if (roll.kind === "plus") return `${roll.dice[0]} + 1 → ${roll.value}`;
  return String(roll.value);
}

/** Lines shown at the top of the board for the current moment (pure, for tests). */
export function boardBanner(board: BoardWire, name: (slot: number) => string, self: number, diceShown: boolean): { title: string; detail: string } {
  const who = board.current,
    me = who === self && who >= 0;
  switch (board.phase) {
    case "intro":
      return { title: MODE_NAMES[board.mode], detail: board.round === 1 ? "İlk mini oyun hazırlanıyor" : `Tur ${board.round} · Sıradaki mini oyun` };
    case "minigame":
      return { title: MODE_NAMES[board.mode], detail: board.mini === "results" ? "Sonuçlar · Tahtaya dönülüyor" : "Mini oyun sürüyor" };
    case "choose":
      return me
        ? { title: "Mini oyunu kazandın!", detail: "Zarını seç: iki zarın büyüğü ya da tek zar +1" }
        : { title: `${name(who)} mini oyunu kazandı`, detail: "Zarını seçiyor…" };
    case "roll":
      return me ? { title: "Sıra sende!", detail: "Zarını at" } : { title: `Sıra ${name(who)}'da`, detail: "Zar atıyor…" };
    case "move": {
      const roll = board.roll!;
      if (!diceShown) return { title: `${name(roll.slot)} zar atıyor…`, detail: roll.kind === "two" ? "İki zar · büyüğü alınır" : roll.kind === "plus" ? "Tek zar +1" : "Tek zar" };
      return {
        title: `${roll.slot === self ? "Sen" : name(roll.slot)}: ${roll.value} kare`,
        detail: `${rollText(roll)}${roll.auto ? " · otomatik" : ""} · ${roll.to >= board.length ? "Hazineye ulaştı!" : `${roll.to}. kare`}`,
      };
    }
    case "finished":
      return { title: board.winner === self ? "Hazineyi buldun!" : `${name(board.winner)} kazandı!`, detail: board.reason === "forfeit" ? "Rakipler ayrıldı" : "Hazineye ilk o ulaştı" };
  }
}
