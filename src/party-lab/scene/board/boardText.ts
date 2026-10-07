import type { WinnerChoice } from "../../../../shared/party-lab/board/rules";
import type { BoardEffect, BoardRoll, BoardWire } from "../../../../shared/party-lab/board/wire";
import { MODE_NAMES } from "../../../../shared/party-lab/modes";

export const CHOICE_LABELS: Record<WinnerChoice, string> = { two: "🎲🎲 İki zar", plus: "🎲 +1" };

/** "4 ve 2 → 4", "3 + 1 → 4", "5"; a bonus die adds " · +1 bonus → 6". */
export function rollText(roll: BoardRoll) {
  const base = roll.value - (roll.bonus ? 1 : 0);
  const text = roll.kind === "two" ? `${roll.dice[0]} ve ${roll.dice[1]} → ${base}` : roll.kind === "plus" ? `${roll.dice[0]} + 1 → ${base}` : String(base);
  return roll.bonus ? `${text} · +1 bonus → ${roll.value}` : text;
}

/**
 * The HUD notice for a special square ("Hamsi kaydıraktan kaydı!"). Names never take a
 * suffix, so any nickname reads right; the player's own effects are in the second person.
 */
export function effectText(effect: BoardEffect, name: (slot: number) => string, self: number, length: number): { title: string; detail: string } {
  const me = effect.slot === self,
    who = name(effect.slot),
    route = `${effect.from}. kare → ${effect.to >= length ? "hazine" : `${effect.to}. kare`}`;
  switch (effect.type) {
    case "forward": {
      const steps = effect.to - effect.from;
      return { title: me ? `${steps} kare ileri gittin!` : `${who} ${steps} kare ileri gitti!`, detail: effect.to >= length ? (me ? "Hazineye ulaştın!" : "Hazineye ulaştı!") : route };
    }
    case "back": {
      const steps = effect.from - effect.to;
      return { title: me ? `${steps} kare geri gittin!` : `${who} ${steps} kare geri gitti!`, detail: effect.to === 0 ? "Başlangıca döndü" : route };
    }
    case "ladder":
      return { title: me ? "Merdivenden çıktın!" : `${who} merdivenden çıktı!`, detail: route };
    case "slide":
      return { title: me ? "Kaydıraktan kaydın!" : `${who} kaydıraktan kaydı!`, detail: route };
    case "bonus":
      return effect.gained
        ? { title: me ? "Bonus zar kazandın!" : `${who} bonus zar kazandı!`, detail: "Sonraki zara +1" }
        : { title: "Bonus zar birikmez", detail: `${who}: zaten +1 var` };
    case "swap":
      if (effect.other < 0) return { title: "Yer değiştirecek kimse yok!", detail: "Herkes aynı karede" };
      return {
        title: me ? `${name(effect.other)} ile yer değiştirdin!` : effect.other === self ? `${who} seninle yer değiştirdi!` : `${who} ile ${name(effect.other)} yer değiştirdi!`,
        detail: `${effect.from}. kare ↔ ${effect.to}. kare`,
      };
  }
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
      if (!diceShown)
        return { title: `${name(roll.slot)} zar atıyor…`, detail: `${roll.kind === "two" ? "İki zar · büyüğü alınır" : roll.kind === "plus" ? "Tek zar +1" : "Tek zar"}${roll.bonus ? " · +1 bonus" : ""}` };
      return {
        title: `${roll.slot === self ? "Sen" : name(roll.slot)}: ${roll.value} kare`,
        detail: `${rollText(roll)}${roll.auto ? " · otomatik" : ""} · ${roll.to >= board.length ? "Hazineye ulaştı!" : `${roll.to}. kare`}`,
      };
    }
    case "effect":
      return board.effect ? effectText(board.effect, name, self, board.length) : { title: "", detail: "" };
    case "finished":
      return { title: board.winner === self ? "Hazineyi buldun!" : `${name(board.winner)} kazandı!`, detail: board.reason === "forfeit" ? "Rakipler ayrıldı" : "Hazineye ilk o ulaştı" };
  }
}
