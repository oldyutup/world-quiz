import type { SpecialType } from "../../../../shared/party-lab/board/config";

/**
 * How each special square looks: one colour per type (distinct hues, so they read from the
 * overview), a white glyph drawn as stroked SVG paths in a 24 × 24 box (the same paths on
 * the 3D tiles, through Path2D, and in the HUD legend), a name and a one-line rule.
 * Directional glyphs (İleri, Geri) point "up" and are turned along the path on the board.
 */
export interface SquareStyle {
  color: string;
  name: string;
  rule: string;
  glyph: string;
  /** Turned to the direction of travel on the board. */
  directional: boolean;
}
export const SQUARE_STYLE: Readonly<Record<SpecialType, SquareStyle>> = {
  forward: { color: "#3f9e57", name: "İleri", rule: "3 kare ileri", glyph: "M6 13l6-6 6 6M6 19l6-6 6 6", directional: true },
  bonus: {
    color: "#ee8a1c",
    name: "Bonus zar",
    rule: "Sonraki zara +1",
    glyph: "M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM8.6 8.6h.01M12 12h.01M15.4 15.4h.01",
    directional: false,
  },
  back: { color: "#d6453d", name: "Geri", rule: "3 kare geri", glyph: "M6 5l6 6 6-6M6 11l6 6 6-6", directional: true },
  slide: { color: "#8456c8", name: "Kaydırak", rule: "Alt satıra kayar", glyph: "M3 8c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0", directional: false },
  ladder: { color: "#3a7fd0", name: "Merdiven", rule: "Üst satıra çıkar", glyph: "M8 3v18M16 3v18M8 7.5h8M8 12h8M8 16.5h8", directional: false },
  swap: { color: "#15a29b", name: "Yer değiştir", rule: "Rastgele biriyle yer değiştirir", glyph: "M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4", directional: false },
};
/** Legend order: rewards, penalties, then the swap. */
export const LEGEND_ORDER: readonly SpecialType[] = ["forward", "bonus", "ladder", "back", "slide", "swap"];
/** Stroke width of the glyphs (24 × 24 box). */
export const GLYPH_STROKE = 2.6;
