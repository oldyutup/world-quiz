import { COLOR_IDS, COLOR_NAMES, COLOR_SYMBOLS, type ColorIndex } from "../../../../shared/party-lab/simulation/colors/config";

/**
 * Renk Kaosu's gameplay colours (sRGB). Chosen so every pair stays apart under simulated
 * deuteranopia, protanopia and tritanopia (CIELAB ΔE ≥ 35; normal vision ≥ 66) and away from
 * the player colours of the same hue (ΔE ≥ 36: Player 1 amber vs yellow, Player 2 rose vs
 * pink, Player 3 sky vs blue). The symbol on every tile is the second cue.
 */
export const TILE_HEX: readonly string[] = ["#1643d3", "#f8d51e", "#20b270", "#eb47b3"];
/** Text/symbol ink on each colour (HUD swatch, the big call). */
export const TILE_INK: readonly string[] = ["#ffffff", "#3d3000", "#053a21", "#ffffff"];
/** HUD label per colour: "MAVİ". */
export const colorLabel = (color: ColorIndex) => COLOR_NAMES[COLOR_IDS[color]].toLocaleUpperCase("tr-TR");
export const colorSymbol = (color: ColorIndex) => COLOR_SYMBOLS[COLOR_IDS[color]];
