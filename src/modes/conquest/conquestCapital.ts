/**
 * Conquest (Kuşatma) — capital / "merkez" region registry.
 *
 * Single source of truth for which region(s) carry capital status. Today
 * the only capital is Ankara, but the structure is a Set so a future
 * multi-capital or campaign-specific capital system can extend it without
 * spreading raw "ankara_cevre" string literals through detection code.
 *
 * Anything that needs to ask "is this region the merkez?" — the cinematic
 * reveal banner, the map's golden pulse FX, the bonus-toast suppression
 * window — should route through here, not hardcode the id locally.
 */

import type { ConquestRegionId } from "./types";

/** Current marquee capital. Kept as a named export so call sites read as
 *  intent ("the capital fell"), not as a magic string. */
export const CAPITAL_REGION_ID: ConquestRegionId = "ankara_cevre";

/** All region ids that carry capital status. Set-based so future systems
 *  (multi-capital campaigns, dynamic re-coronation) just extend membership
 *  — every consumer keeps working unchanged. */
export const CAPITAL_REGION_IDS: ReadonlySet<ConquestRegionId> = new Set([
  CAPITAL_REGION_ID,
]);

export function isCapitalRegion(regionId: ConquestRegionId | null | undefined): boolean {
  return regionId != null && CAPITAL_REGION_IDS.has(regionId);
}

/** Hold window for the capital reveal cinematic — banner stays on screen,
 *  the map pulse plays through, and the standard bonus toast is held back
 *  so the two surfaces never stack. Keep banner ttl ≤ this value so the
 *  toast lands cleanly after the banner exits. */
export const CAPITAL_REVEAL_HOLD_MS = 1400;
