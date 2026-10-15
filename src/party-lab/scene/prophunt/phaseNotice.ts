import type { Recipe } from "../../audio/sfx";

/**
 * Saklambaç's big phase calls, the same locally and online:
 * - hiders, while the seeker counts: "Avcı sayıyor: 12" (whole seconds, counting down);
 * - hiders still hidden, when the count ends: "Avcı artık seni arıyor, dikkat!" for `hunted` s, with an alarm;
 * - the seeker, when the count ends: "ARA!" for `seek` s, with a short call.
 * The calls at the count's end show once, on the hiding → search change itself (never on a
 * reconnect into a running search).
 */
export const PROP_NOTICE = { hunted: 2.8, seek: 1.6 } as const;
export type PropNoticeKind = "counting" | "hunted" | "seek";
export interface PropNotice { kind: PropNoticeKind; text: string }

export function propNotice(phase: string, role: "seeker" | "hider" | null, alive: boolean, remaining: number, sinceSearch: number): PropNotice | null {
  if (phase === "hiding" && role === "hider") return { kind: "counting", text: `Avcı sayıyor: ${Math.max(1, Math.ceil(remaining - 1e-6))}` };
  if (phase !== "search") return null;
  if (role === "hider" && alive && sinceSearch < PROP_NOTICE.hunted) return { kind: "hunted", text: "Avcı artık seni arıyor, dikkat!" };
  if (role === "seeker" && sinceSearch < PROP_NOTICE.seek) return { kind: "seek", text: "ARA!" };
  return null;
}

/** When this screen saw the count end (seconds on the caller's clock); `update` is true on that frame only. */
export class PropNoticeClock {
  searchAt = -Infinity;
  private phase: string | null = null;
  update(phase: string, now: number) {
    const started = this.phase === "hiding" && phase === "search";
    if (started) this.searchAt = now;
    if (phase !== "search") this.searchAt = -Infinity;
    this.phase = phase;
    return started;
  }
  since(now: number) { return now - this.searchAt; }
}

/** Hiders: a falling two-tone alarm ("da-dum, da-dum"). Seeker: a short rising call. Both centred, never a direction. */
export const HUNTED_RECIPE: Recipe = { frequency: 880, end: 620, duration: 0.7, noise: 0.03, gain: 0.34, priority: 2, cooldown: 0, notes: [1, 0.75, 1, 0.75] };
export const SEEK_RECIPE: Recipe = { frequency: 520, end: 980, duration: 0.42, noise: 0.05, gain: 0.3, priority: 2, cooldown: 0, notes: [1, 1.26] };

/** Writes the call into its HUD element (only on a change). */
export function showPropNotice(element: HTMLElement | null, notice: PropNotice | null) {
  if (!element) return;
  const text = notice?.text ?? "", kind = notice?.kind ?? "";
  if (element.textContent !== text) element.textContent = text;
  if (element.dataset.kind !== kind) element.dataset.kind = kind;
}
