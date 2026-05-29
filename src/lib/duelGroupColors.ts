/**
 * Color palette for the Duel Group (Ülke Yaz Çok Oyunculu) mode.
 *
 * Pure data + helpers — no React, no Supabase. Used by both the lobby color
 * picker and the map / scoreboard color resolution.
 */

export type DuelGroupColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan"
  | "lime"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "white";

export const DUEL_GROUP_COLORS: DuelGroupColor[] = [
  "red", "blue", "green", "yellow",
  "purple", "orange", "pink", "cyan",
  "lime", "amber", "rose", "violet",
  "teal", "slate", "white",
];

export const DUEL_GROUP_COLOR_LABEL: Record<DuelGroupColor, string> = {
  red:    "Kırmızı",
  blue:   "Mavi",
  green:  "Yeşil",
  yellow: "Sarı",
  purple: "Mor",
  orange: "Turuncu",
  pink:   "Pembe",
  cyan:   "Camgöbeği",
  lime:   "Limon",
  amber:  "Kehribar",
  rose:   "Gül",
  violet: "Menekşe",
  teal:   "Deniz Yeşili",
  slate:  "Kurşuni",
  white:  "Beyaz",
};

export const DUEL_GROUP_COLOR_HEX: Record<DuelGroupColor, string> = {
  red:    "#ef4444",
  blue:   "#3b82f6",
  green:  "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
  pink:   "#ec4899",
  cyan:   "#06b6d4",
  lime:   "#84cc16",
  amber:  "#f59e0b",
  rose:   "#f43f5e",
  violet: "#8b5cf6",
  teal:   "#14b8a6",
  slate:  "#94a3b8",
  white:  "#f8fafc",
};

/** Fallback hex when a player row has no color (mid-migration / legacy data). */
export const DUEL_GROUP_FALLBACK_HEX = "#9ca3af";

export function isDuelGroupColor(value: unknown): value is DuelGroupColor {
  return typeof value === "string"
    && (DUEL_GROUP_COLORS as readonly string[]).includes(value);
}

/**
 * Resolve a color for each player. Honours an explicit `color_key`; for rows
 * without one, falls back to the first unused palette entry deterministically
 * (by joined_at order — caller controls the input order).
 */
export function resolveDuelGroupColors<
  P extends { id: string; color_key?: string | null },
>(players: P[]): Record<string, DuelGroupColor> {
  const out: Record<string, DuelGroupColor> = {};
  const used = new Set<DuelGroupColor>();
  for (const p of players) {
    if (p.color_key && isDuelGroupColor(p.color_key)) {
      out[p.id] = p.color_key;
      used.add(p.color_key);
    }
  }
  for (const p of players) {
    if (out[p.id]) continue;
    const free = DUEL_GROUP_COLORS.find(c => !used.has(c)) ?? DUEL_GROUP_COLORS[0];
    out[p.id] = free;
    used.add(free);
  }
  return out;
}

/** Pick the first palette entry not present in `usedColors`. */
export function pickFreeDuelGroupColor(
  usedColors: Iterable<string | null | undefined>,
): DuelGroupColor {
  const used = new Set<string>();
  for (const c of usedColors) if (c) used.add(c);
  return DUEL_GROUP_COLORS.find(c => !used.has(c)) ?? DUEL_GROUP_COLORS[0];
}

export function hexForDuelGroupColor(c: string | null | undefined): string {
  if (c && isDuelGroupColor(c)) return DUEL_GROUP_COLOR_HEX[c];
  return DUEL_GROUP_FALLBACK_HEX;
}
