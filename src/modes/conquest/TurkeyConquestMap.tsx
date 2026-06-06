/**
 * TurkeyConquestMap — merged-region SVG map for Türkiye Kuşatması.
 *
 * Renders 24 conquest-region paths produced by unioning the underlying 81
 * province shapes (see scripts/build-turkey-regions.ts).  No province
 * subdivisions are visible — each region is one clean shape.
 *
 * viewBox: 0 0 1005 490 (matches the source province data).
 *
 * Visual layers (back → front):
 *  1  fills – one path per region (fill + region-coloured border stroke,
 *             evenodd handles non-contiguous regions like Istanbul or KD-Anadolu)
 *  2  pulse – legal-target animated pulse rings (one per legal region)
 *  3  flash – illegal-click flash overlay (one path, the flashing region)
 *  4  label – region labels with dark text-outline for readability
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
} from "./types";
import { TURKEY_CONQUEST_REGION_PATHS } from "./maps/turkey-regions";
import { getRegionPoints } from "./regionPoints";
import { resolveActiveBonus } from "./conquestRoundBonuses";
import { BEREKET_HARVEST_INTERVAL } from "./conquestGameplay";
import { CAPITAL_REGION_IDS } from "./conquestCapital";

// Per-region offset (in SVG units) for the point badge, relative to label
// position. Default = badge sits just above the region label. Override only
// where the default would collide with another label or the map edge.
const REGION_BADGE_OFFSET: Record<string, { dx: number; dy: number }> = {
  trakya:           { dx: -2, dy: -26 },
  istanbul_kocaeli: { dx: 34,  dy: -1 },
  kuzeydogu_anadolu:{ dx: 0,   dy: -23 },
  guney_marmara: { dx: 0, dy: -24 },
  kuzey_ege: { dx: 0, dy: -24 },
  dogu_karadeniz: { dx: 0, dy: -22 },
  orta_karadeniz: { dx: 0, dy: -22 },
  bati_karadeniz: { dx: 0, dy: -24 },
  ic_bati_anadolu: { dx: 0, dy: -30 },
  ankara_cevre: { dx: 0, dy: -30 },
  van_hakkari: { dx: 28, dy: -2 },
  mardin: { dx: -10, dy: -8 },
  dicle: { dx: 26, dy: 0 },
  dicle_hatti: { dx: 31, dy: -8 },
  mardin_sirnak: { dx: -39, dy: -7 },
  kars: { dx: 0, dy: -29 },
  erzurum_kars: { dx: 0, dy: -19 },
  guney_ege: { dx: 0, dy: -28 },
  bati_akdeniz: { dx: 0, dy: -28 },
  orta_anadolu: { dx: 0, dy: -21 },
  kapadokya: { dx: 0, dy: -21 },
  hatay_osmaniye: { dx: 0, dy: -24 },
  konya_karaman: { dx: 0, dy: -24 },
  cukurova: { dx: 0, dy: -24 },
  antep_kilis: { dx: 0, dy: -18 },
  malatya_elazig: { dx: 0, dy: -21 },
};
const DEFAULT_BADGE_OFFSET = { dx: 0, dy: -14 };

// ─── Terrain texture underlay ─────────────────────────────────────────────────
// One bitmap stamped through every region path via an SVG <pattern>. The
// shape of "Türkiye" is therefore always the union of the region SVG paths —
// guaranteed pixel-perfect with the foreground map. Swap the PNG to retune
// the look; no code change needed.
const TERRAIN_IMAGE_HREF    = "/assets/backgrounds/turkey-terrain-texture.png?v=1779635172";
const TERRAIN_PATTERN_ID    = "cqTurkeyTerrainImage";
const MAP_VIEWBOX_W         = 1005;
const MAP_VIEWBOX_H         = 490;

// ─── Region label text ────────────────────────────────────────────────────────

const REGION_LABELS: Record<string, string> = {
  trakya:             "Trakya",
  istanbul_kocaeli:   "İstanbul",
  guney_marmara:      "G. Marmara",
  bati_karadeniz:     "Batı Kara.",
  orta_karadeniz:     "Orta Kara.",
  dogu_karadeniz:     "Doğu Kara.",
  kuzeydogu_anadolu:  "KD Anadolu",
  kuzey_ege:          "Kuzey Ege",
  guney_ege:          "Güney Ege",
  bati_akdeniz:       "Batı Akd.",
  cukurova:           "Çukurova",
  ic_bati_anadolu:    "İç Batı",
  ankara_cevre:       "Ankara",
  konya_karaman:      "Konya",
  kapadokya:          "Kapadokya",
  orta_anadolu:       "Orta Anad.",
  erzurum_kars:       "Erzurum",
  van_hakkari:        "Van",
  malatya_elazig:     "Malatya",
  firat_hatti:        "Fırat",
  dicle_hatti:        "Dicle",
  antep_kilis:        "Antep",
  hatay_osmaniye:     "Hatay",
  mardin_sirnak:      "Mardin",
  kars: "Kars",
};

// ─── Region label positions in the 1005×490 SVG coordinate space ─────────────

const REGION_LABEL_POS: Record<string, { x: number; y: number }> = {
  trakya:             { x:  90, y:  56 },
  istanbul_kocaeli:   { x: 190, y: 85 },
  guney_marmara:      { x: 130, y: 155 },
  bati_karadeniz:     { x: 378, y:  68 },
  orta_karadeniz:     { x: 508, y: 110 },
  dogu_karadeniz:     { x: 720, y: 132 },
  kuzeydogu_anadolu:  { x: 710, y: 195 },
  kars:               { x: 915, y: 188 },
  kuzey_ege:          { x: 112, y: 243 },
  guney_ege:          { x: 132, y: 320 },
  bati_akdeniz:       { x: 235, y: 345 },
  cukurova:           { x: 462, y: 374 },
  ic_bati_anadolu:    { x: 255, y: 205 },
  ankara_cevre:       { x: 380, y: 165 },
  konya_karaman:      { x: 352, y: 298 },
  kapadokya:          { x: 490, y: 270 },
  orta_anadolu:       { x: 555, y: 195 },
  erzurum_kars:       { x: 820, y: 172 },
  van_hakkari:        { x: 906, y: 258 },
  malatya_elazig:     { x: 678, y: 268 },
  firat_hatti:        { x: 648, y: 320 },
  dicle_hatti:        { x: 785, y: 285 },
  antep_kilis:        { x: 610, y: 368 },
  hatay_osmaniye:     { x: 552, y: 386 },
  mardin_sirnak:      { x: 837, y: 339 },
};

// ─── Colour palette ───────────────────────────────────────────────────────────

interface ColorTokens {
  fill:         string;
  regionBorder: string;
  text:         string;
  legalFill:    string;
  legalStroke:  string;
}

const COLOR_MAP: Record<string, ColorTokens> = {
  red:     { fill: "rgba(239,68,68,0.22)",    regionBorder: "rgba(239,68,68,0.74)",   text: "#fca5a5", legalFill: "rgba(239,68,68,0.46)",    legalStroke: "#ef4444" },
  blue:    { fill: "rgba(59,130,246,0.22)",   regionBorder: "rgba(59,130,246,0.74)",  text: "#93c5fd", legalFill: "rgba(59,130,246,0.46)",   legalStroke: "#3b82f6" },
  green:   { fill: "rgba(34,197,94,0.22)",    regionBorder: "rgba(34,197,94,0.74)",   text: "#86efac", legalFill: "rgba(34,197,94,0.46)",    legalStroke: "#22c55e" },
  yellow:  { fill: "rgba(234,179,8,0.22)",    regionBorder: "rgba(234,179,8,0.74)",   text: "#fde047", legalFill: "rgba(234,179,8,0.46)",    legalStroke: "#eab308" },
  purple:  { fill: "rgba(168,85,247,0.22)",   regionBorder: "rgba(168,85,247,0.74)",  text: "#d8b4fe", legalFill: "rgba(168,85,247,0.46)",   legalStroke: "#a855f7" },
  orange:  { fill: "rgba(249,115,22,0.22)",   regionBorder: "rgba(249,115,22,0.74)",  text: "#fdba74", legalFill: "rgba(249,115,22,0.46)",   legalStroke: "#f97316" },
  pink:    { fill: "rgba(236,72,153,0.22)",   regionBorder: "rgba(236,72,153,0.74)",  text: "#f9a8d4", legalFill: "rgba(236,72,153,0.46)",   legalStroke: "#ec4899" },
  cyan:    { fill: "rgba(6,182,212,0.22)",    regionBorder: "rgba(6,182,212,0.74)",   text: "#67e8f9", legalFill: "rgba(6,182,212,0.46)",    legalStroke: "#06b6d4" },
  neutral: { fill: "rgba(148,163,184,0.13)",  regionBorder: "rgba(148,196,228,0.62)", text: "rgba(203,213,225,0.82)", legalFill: "rgba(148,163,184,0.30)", legalStroke: "rgba(165,215,245,0.90)" },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  regionStates:   ConquestRegionState[];
  players:        ConquestPlayer[];
  playerColors:   Record<string, ConquestPlayerColor>;
  legalTargetIds: Set<ConquestRegionId>;
  disabled?:      boolean;
  onRegionClick?: (id: ConquestRegionId) => void;
  flashRegionId?: ConquestRegionId | null;
  /**
   * Region ids the LOCAL viewer has armed with a Pusu 🕳️ hidden bonus.
   * The marker is rendered ONLY for these regions and is invisible to
   * every other client — pass an empty set for opponents.  Owner-side
   * intelligence; never leaks to opponents.
   */
  myAmbushRegionIds?: Set<ConquestRegionId>;
  /**
   * Active per-round bonus assignment.  When present, bonus icons + tooltips
   * render against this map; pre-dynamic-bonus rooms (assignment undefined)
   * fall back to the static catalog inside `resolveActiveBonus`.
   */
  roundBonuses?: ConquestRoundBonusAssignment;
  /**
   * Region to dramatize as the "Attack Focus" target — pulses a red ring
   * + ⚔️ glyph until the prop is cleared.  Pure presentation; this never
   * intercepts pointer events or alters legal-target highlights.
   */
  attackTargetRegionId?: ConquestRegionId | null;
  /**
   * True when the local viewer is the current action holder. Drives the
   * "viewer-acting" vs "spectator-turn" data attributes on the wrap so
   * non-holders see a quieter map (faint pulses, no hover, not-allowed
   * cursor). Defaults to true to keep non-gameplay surfaces (lobby
   * previews) at full strength.
   */
  viewerIsHolder?: boolean;
  /**
   * Sınır Karakolu (Kuşatma fate card) — region ids currently carrying
   * an outpost.  Public information: every viewer sees the same set, no
   * owner colouring or owner-only filtering applied.  Empty / undefined
   * keeps the layer dormant for matches with no outpost in play.
   */
  borderOutpostRegions?: Set<ConquestRegionId>;
}

interface OwnershipFxEntry {
  id:        string;
  regionId:  ConquestRegionId;
  colorKey:  string;
}

/** Lifetime of impact ring + capture glow. Matches the longest CSS
 *  keyframe (cqMapCaptureGlow = 1400ms) so React unmounts the SVG nodes
 *  only after the animation has fully resolved — keeps `forwards` from
 *  leaving permanently-styled stale paths in the tree. */
const OWNERSHIP_FX_MS = 1500;

/** Local-only shield-break FX entry — fires when a region transitions
 *  out of any shielded state (open İstanbul shield, or hidden Ankara
 *  shield) without an ownership change.  Region id + monotonic stamp
 *  keep keys unique across re-fires on the same region. */
interface ShieldBreakFxEntry {
  id:       string;
  regionId: ConquestRegionId;
}
/** Slightly longer than the slowest keyframe (cqMapShieldShatter =
 *  900ms) so the React node lives across the full animation. */
const SHIELD_BREAK_FX_MS = 1000;

/** One-shot gold pulse fired on every bonus region whenever the
 *  active `roundBonuses` assignment first appears (match start) or its
 *  region set changes.  Pure presentation; never re-fires on the
 *  steady state.  Length must match the slowest CSS keyframe in
 *  `cqMapBonusIntroPulse` so React unmounts after the animation is
 *  done; reduced-motion clients get a static dim halo instead.
 *
 *  Tuned to ~5s so the bonus tile is legible at match start without
 *  competing with the round-intro overlay.  The CSS keyframe holds
 *  visibility through the bulk of that window and tapers to 0 at the
 *  end, so the steady-state map stays calm. */
const BONUS_INTRO_FX_MS = 10000;

/** Capital "merkez" reveal FX entry — fires only when a region in
 *  CAPITAL_REGION_IDS changes hands (any non-null new owner). Renders a
 *  golden/white halo + center pulse on top of the standard capture glow
 *  so the moment reads as ceremonial rather than tactical. */
interface CapitalFxEntry {
  id:       string;
  regionId: ConquestRegionId;
}
/** Hold matches the slowest capital keyframe (cqMapCapitalPulse = 1400ms)
 *  so React unmounts after the animation has fully resolved. */
const CAPITAL_FX_MS = 1500;

/** Eight short radial cracks rendered around the label anchor.  Angle in
 *  degrees, length in SVG units.  Mild variance keeps it from feeling
 *  like a perfect snowflake while staying compact for mobile. */
const SHIELD_SHATTER_CRACKS: ReadonlyArray<{ a: number; len: number }> = [
  { a:    0, len: 26 },
  { a:   46, len: 22 },
  { a:   92, len: 28 },
  { a:  138, len: 21 },
  { a:  180, len: 25 },
  { a:  224, len: 23 },
  { a:  268, len: 27 },
  { a:  314, len: 22 },
];

export default function TurkeyConquestMap({
  regionStates,
  players,
  playerColors,
  legalTargetIds,
  disabled = false,
  onRegionClick,
  flashRegionId,
  attackTargetRegionId = null,
  viewerIsHolder = true,
  roundBonuses,
  myAmbushRegionIds,
  borderOutpostRegions,
}: Props) {
  const stateById   = Object.fromEntries(regionStates.map((rs) => [rs.regionId, rs]));
  const playerById  = Object.fromEntries(players.map((p) => [p.id, p]));
  const interactive = !!onRegionClick && !disabled;
  // The map is "active" for the local viewer when it's their turn to move.
  // Spectator turns keep the click handlers wired (so illegal taps still
  // flash) but visually retreat — see the data-spectator-turn CSS block.
  const viewerActing    = interactive && viewerIsHolder;
  const spectatorTurn   = interactive && !viewerIsHolder;

  // ── Ownership-change FX (impact ring + capture glow) ───────────────
  // Pure local presentation: diff regionStates against the previous render
  // and mount one-shot SVG overlays for each new owner.  No new sync field.
  // First mount is treated as the baseline (no events emitted).
  const prevOwnersRef = useRef<Record<string, string | null> | null>(null);
  const [ownershipFx, setOwnershipFx] = useState<OwnershipFxEntry[]>([]);
  const fxTimeoutsRef = useRef<Map<string, number>>(new Map());

  // ── Shield-break FX (open shield or hidden shield → none) ──────────
  // Same diff pattern as ownership: prevShieldsRef is the baseline; on
  // any transition out of a shielded state we mount a one-shot overlay
  // for the affected region.  Gated by "owner did NOT change in the same
  // diff" so the capture glow keeps its lane when the two events would
  // otherwise stack.
  const prevShieldsRef = useRef<Record<string, { open: boolean; hidden: boolean }> | null>(null);
  const [shieldBreakFx, setShieldBreakFx] = useState<ShieldBreakFxEntry[]>([]);
  const shieldFxTimeoutsRef = useRef<Map<string, number>>(new Map());

  // ── Capital reveal FX (Ankara / future capitals) ───────────────────
  // Watches the same ownership diff as the standard capture glow, but
  // only fires for regions in CAPITAL_REGION_IDS. Layers on top of the
  // regular FX rather than replacing it so a capital capture reads as
  // "normal capture + ceremonial overlay" instead of a separate state
  // machine.
  const [capitalFx, setCapitalFx] = useState<CapitalFxEntry[]>([]);
  const capitalFxTimeoutsRef = useRef<Map<string, number>>(new Map());

  // ── Bonus-region intro pulse ───────────────────────────────────────
  // Fires once whenever the active bonus assignment's region set first
  // appears (match start) or changes.  Drives the gold region-shaped
  // halo + chip glow that lets players spot where the round's bonuses
  // landed at a glance.  Tracked by a join-key over the bonus region
  // ids so identical assignments don't re-fire on every render.
  const [bonusIntroFx, setBonusIntroFx] = useState<ConquestRegionId[]>([]);
  const prevBonusKeyRef       = useRef<string | null>(null);
  const bonusIntroTimeoutRef  = useRef<number | null>(null);

  // Liman ⚓ income pulse — short re-fire of the bonus halo whenever a
  // region's `limanIncomeTicks` increments.  Watches per-region tick counts
  // so we re-pulse for each income tick on top of the steady-state badge.
  // Kept separate from bonusIntroFx so the per-match intro halo's 10s
  // window doesn't interact with the per-tick 1.4s pulse.
  const [limanIncomeFx, setLimanIncomeFx]     = useState<ConquestRegionId[]>([]);
  const prevLimanTicksRef                     = useRef<Map<ConquestRegionId, number>>(new Map());
  const limanFxTimeoutsRef                    = useRef<Map<string, number>>(new Map());

  useEffect(() => () => {
    fxTimeoutsRef.current.forEach(h => window.clearTimeout(h));
    fxTimeoutsRef.current.clear();
    shieldFxTimeoutsRef.current.forEach(h => window.clearTimeout(h));
    shieldFxTimeoutsRef.current.clear();
    capitalFxTimeoutsRef.current.forEach(h => window.clearTimeout(h));
    capitalFxTimeoutsRef.current.clear();
    limanFxTimeoutsRef.current.forEach(h => window.clearTimeout(h));
    limanFxTimeoutsRef.current.clear();
    if (bonusIntroTimeoutRef.current !== null) {
      window.clearTimeout(bonusIntroTimeoutRef.current);
      bonusIntroTimeoutRef.current = null;
    }
  }, []);

  // Liman income tick → short halo pulse on the producing region.
  // Diff regionStates' `limanIncomeTicks`; any region whose tick count rose
  // since the last snapshot gets pushed into `limanIncomeFx` for the FX
  // duration.  Initial mount seeds prev counts without firing FX (we only
  // celebrate true increments, not catch-up reads).
  useEffect(() => {
    const prev = prevLimanTicksRef.current;
    const next = new Map<ConquestRegionId, number>();
    const toPulse: ConquestRegionId[] = [];
    for (const rs of regionStates) {
      const ticks = rs.limanIncomeTicks ?? 0;
      next.set(rs.regionId, ticks);
      if (prev.size > 0 && (prev.get(rs.regionId) ?? 0) < ticks) {
        toPulse.push(rs.regionId);
      }
    }
    prevLimanTicksRef.current = next;
    if (toPulse.length === 0) return;
    setLimanIncomeFx(p => [...p, ...toPulse]);
    const stamp = Date.now();
    toPulse.forEach((rid, i) => {
      const key = `liman-fx-${rid}-${stamp}-${i}`;
      const h   = window.setTimeout(() => {
        setLimanIncomeFx(p => {
          // Drop only one occurrence of rid so overlapping pulses don't all
          // clear at once on the first timeout firing.
          const idx = p.indexOf(rid);
          if (idx < 0) return p;
          const out = p.slice();
          out.splice(idx, 1);
          return out;
        });
        limanFxTimeoutsRef.current.delete(key);
      }, OWNERSHIP_FX_MS);
      limanFxTimeoutsRef.current.set(key, h);
    });
  }, [regionStates]);

  useEffect(() => {
    const current: Record<string, string | null> = {};
    for (const rs of regionStates) current[rs.regionId] = rs.ownerPlayerId;

    const prev = prevOwnersRef.current;
    if (!prev) {
      prevOwnersRef.current = current;
      return;
    }

    const fresh: OwnershipFxEntry[] = [];
    const now = Date.now();
    for (const rid of Object.keys(current)) {
      const before = prev[rid] ?? null;
      const after  = current[rid];
      if (before === after) continue;
      if (after === null)   continue; // no neutralisation in gameplay today
      const colorKey = playerColors[after] ?? "neutral";
      const id = `fx:${rid}:${now}`;
      fresh.push({ id, regionId: rid as ConquestRegionId, colorKey });
    }

    if (fresh.length > 0) {
      setOwnershipFx(prev => [...prev, ...fresh]);
      for (const fx of fresh) {
        const handle = window.setTimeout(() => {
          setOwnershipFx(cur => cur.filter(e => e.id !== fx.id));
          fxTimeoutsRef.current.delete(fx.id);
        }, OWNERSHIP_FX_MS);
        fxTimeoutsRef.current.set(fx.id, handle);
      }
    }

    // Capital overlay: same diff source, narrower membership. We use the
    // freshly computed `fresh` list rather than re-iterating so the two
    // FX stay in lockstep and never disagree on which tick fired.
    const capitalFresh: CapitalFxEntry[] = fresh
      .filter(e => CAPITAL_REGION_IDS.has(e.regionId))
      .map(e => ({ id: `cap:${e.id}`, regionId: e.regionId }));
    if (capitalFresh.length > 0) {
      setCapitalFx(prev => [...prev, ...capitalFresh]);
      for (const fx of capitalFresh) {
        const handle = window.setTimeout(() => {
          setCapitalFx(cur => cur.filter(e => e.id !== fx.id));
          capitalFxTimeoutsRef.current.delete(fx.id);
        }, CAPITAL_FX_MS);
        capitalFxTimeoutsRef.current.set(fx.id, handle);
      }
    }

    prevOwnersRef.current = current;
  }, [regionStates, playerColors]);

  useEffect(() => {
    const current: Record<string, { open: boolean; hidden: boolean }> = {};
    for (const rs of regionStates) {
      current[rs.regionId] = {
        open:   rs.shielded === true,
        hidden: !!rs.hiddenShieldOwnerId,
      };
    }

    const prev = prevShieldsRef.current;
    if (!prev) {
      prevShieldsRef.current = current;
      return;
    }

    // Skip shield-break FX on a region whose owner also changed this tick —
    // the capture glow already covers that moment (and per gameplay, real
    // shield-break events leave ownership intact, so this guard just protects
    // the legacy flipOwnership path from double-stacking effects).
    const ownerPrev = prevOwnersRef.current ?? {};
    const ownerCur: Record<string, string | null> = {};
    for (const rs of regionStates) ownerCur[rs.regionId] = rs.ownerPlayerId;

    const fresh: ShieldBreakFxEntry[] = [];
    const now = Date.now();
    for (const rid of Object.keys(current)) {
      const before = prev[rid] ?? { open: false, hidden: false };
      const after  = current[rid];
      const brokeOpen   = before.open   && !after.open;
      const brokeHidden = before.hidden && !after.hidden;
      if (!brokeOpen && !brokeHidden) continue;
      if ((ownerPrev[rid] ?? null) !== (ownerCur[rid] ?? null)) continue;
      fresh.push({ id: `shield-fx:${rid}:${now}`, regionId: rid as ConquestRegionId });
    }

    if (fresh.length > 0) {
      setShieldBreakFx(p => [...p, ...fresh]);
      for (const fx of fresh) {
        const handle = window.setTimeout(() => {
          setShieldBreakFx(cur => cur.filter(e => e.id !== fx.id));
          shieldFxTimeoutsRef.current.delete(fx.id);
        }, SHIELD_BREAK_FX_MS);
        shieldFxTimeoutsRef.current.set(fx.id, handle);
      }
    }
    prevShieldsRef.current = current;
  }, [regionStates]);

  // Bonus-intro pulse trigger.  Watches the *set* of bonus region ids
  // (sorted + joined) so re-renders with the same assignment never
  // re-fire the pulse — only a true assignment change (match start, or
  // a future per-round rotation) does.  Legacy pre-dynamic saves have
  // no roundBonuses prop; the pulse simply stays inert for them rather
  // than guessing region ids from the static catalog.
  useEffect(() => {
    const ids = roundBonuses ? Object.keys(roundBonuses).sort() : [];
    const key = ids.join("|");
    if (prevBonusKeyRef.current === key) return;
    prevBonusKeyRef.current = key;
    if (bonusIntroTimeoutRef.current !== null) {
      window.clearTimeout(bonusIntroTimeoutRef.current);
      bonusIntroTimeoutRef.current = null;
    }
    if (ids.length === 0) {
      setBonusIntroFx([]);
      return;
    }
    setBonusIntroFx(ids as ConquestRegionId[]);
    bonusIntroTimeoutRef.current = window.setTimeout(() => {
      setBonusIntroFx([]);
      bonusIntroTimeoutRef.current = null;
    }, BONUS_INTRO_FX_MS);
  }, [roundBonuses]);

  const handleKey = useCallback((
    e: React.KeyboardEvent,
    regionId: ConquestRegionId,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRegionClick?.(regionId);
    }
  }, [onRegionClick]);

  // Pre-compute per-region display state once per render.
  // Legal-target affordance (fill, pulse ring, dimming of non-legals) is
  // a *call to action* for the local viewer: it only makes sense when
  // this player is the action holder AND the map is interactive. For
  // any spectator view, or any non-action sub-phase where clicks aren't
  // accepted (reveal, defense_duel, round_result), the map reads as a
  // pure ownership snapshot. This prevents the waiting player from
  // seeing "attackable" hints that belong to the opponent.
  const showLegalAffordance = viewerActing;
  const regionEntries = TURKEY_CONQUEST_REGION_PATHS.map(({ id, d }) => {
    const rid       = id as ConquestRegionId;
    const rs        = stateById[id];
    const owner     = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
    const colorKey  = owner ? (playerColors[owner.id] ?? "neutral") : "neutral";
    const c         = COLOR_MAP[colorKey] ?? COLOR_MAP.neutral;
    const isLegal   = showLegalAffordance && legalTargetIds.has(rid);
    const isFlash   = flashRegionId === id;
    const isDimmed  = showLegalAffordance && interactive && !isLegal;
    const isShielded = !!rs?.shielded;          // open shield (İstanbul)
    const fill      = isLegal ? c.legalFill   : c.fill;
    const stroke    = isLegal ? c.legalStroke : c.regionBorder;
    const labelPos  = REGION_LABEL_POS[id] ?? { x: 0, y: 0 };
    const label     = REGION_LABELS[id]    ?? id;
    const points    = getRegionPoints(rid);
    const bonus     = resolveActiveBonus(roundBonuses, rid);
    // Liman ⚓: surface the per-tenure income counter (N/10) on the badge so
    // every viewer sees the region producing value.  null when this region
    // doesn't carry Liman, so the badge stays off.
    const limanTicks = bonus?.type === "liman" ? (rs?.limanIncomeTicks ?? 0) : null;
    // Bereketli Ova 🌾: surface the held-tenure counter (N/3) on the badge,
    // matching the Liman pattern.  Once the harvest has fired the counter is
    // parked at INTERVAL, so we surface that as a "harvested" sentinel
    // (rendered as "✓") to make it clear no more +4 is coming until the
    // region changes hands.  null when this region doesn't carry Bereket.
    const bereketTurns    = bonus?.type === "cukurova_score" ? (rs?.bereketHarvestTurns ?? 0) : null;
    const bereketHarvested = bereketTurns !== null && bereketTurns >= BEREKET_HARVEST_INTERVAL;
    // Native browser tooltip line: "İstanbul — 5 puan · 🛡️ Kale Surları"
    // Desktop hover only; touch devices ignore the SVG <title>.
    const ownerSuffix = owner ? ` (${owner.name})` : "";
    const limanSuffix = limanTicks !== null ? ` (${limanTicks}/10)` : "";
    const bereketSuffix = bereketTurns !== null
      ? (bereketHarvested
          ? ` (Hasat tamamlandı)`
          : ` (Hasat ${bereketTurns}/${BEREKET_HARVEST_INTERVAL})`)
      : "";
    const bonusSuffix = bonus ? ` · ${bonus.icon} ${bonus.label}${limanSuffix}${bereketSuffix}` : "";
    const tooltip   = `${label}${ownerSuffix} — ${points} puan${bonusSuffix}`;
    return { rid, id, d, owner, c, isLegal, isFlash, isDimmed, isShielded, fill, stroke, labelPos, label, points, bonus, limanTicks, bereketTurns, bereketHarvested, tooltip };
  });

  return (
    <div
      className="cq-turkey-map-wrap"
      data-viewer-acting={viewerActing ? "" : undefined}
      data-spectator-turn={spectatorTurn ? "" : undefined}
    >
      <svg
        viewBox="0 0 1005 490"
        preserveAspectRatio="xMidYMid meet"
        className="cq-turkey-map-svg"
        aria-label="Türkiye Kuşatması haritası"
        role="img"
      >
        {/* ── Defs: terrain bitmap pattern, sized to the SVG viewBox so it
             stamps once across the whole map and gets clipped by each region
             path. Drop a new PNG at TERRAIN_IMAGE_HREF to retune the look. */}
        <defs>
          <pattern
            id={TERRAIN_PATTERN_ID}
            patternUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={MAP_VIEWBOX_W}
            height={MAP_VIEWBOX_H}
          >
            <image
              href={TERRAIN_IMAGE_HREF}
              x="0"
              y="0"
              width={MAP_VIEWBOX_W}
              height={MAP_VIEWBOX_H}
              preserveAspectRatio="xMidYMid slice"
            />
          </pattern>
        </defs>

        {/* ── Layer 0: terrain image underlay (purely visual; never intercepts clicks) ── */}
        <g className="cq-terrain-image-underlay" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, d }) => (
            <path
              key={`terrain-img-${id}`}
              d={d}
              className="cq-region-terrain-image"
              fill={`url(#${TERRAIN_PATTERN_ID})`}
              fillRule="evenodd"
            />
          ))}
        </g>


        {/* ── Layer 1: region fills + borders (single path per region) ── */}
        {regionEntries.map(({ rid, id, d, owner, isLegal, isDimmed, fill, stroke, tooltip }) => (
          <path
            key={`region-${id}`}
            d={d}
            className="cq-map-region"
            fillRule="evenodd"
            data-interactive={interactive ? "" : undefined}
            data-legal={isLegal ? "" : undefined}
            style={{
              fill,
              stroke,
              opacity: isDimmed ? 0.45 : 1,
            }}
            onClick={interactive ? () => onRegionClick!(rid) : undefined}
            onKeyDown={interactive ? (e) => handleKey(e, rid) : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? (isLegal ? 0 : -1) : undefined}
            aria-label={`${REGION_LABELS[id] ?? id}${owner ? ` — ${owner.name}` : " — Tarafsız"}${isLegal ? " (hedef)" : ""}`}
          >
            <title>{tooltip}{isLegal ? " (hedef)" : ""}</title>
          </path>
        ))}

        {/* ── Layer 2: legal-target pulse rings ──────────────────────── */}
        {regionEntries
          .filter((r) => r.isLegal)
          .map(({ id, d, c }) => (
            <path
              key={`pulse-${id}`}
              d={d}
              className="cq-map-pulse-ring"
              fillRule="evenodd"
              fill="none"
              stroke={c.legalStroke}
              strokeWidth={2}
              aria-hidden="true"
            />
          ))}

        {/* ── Layer 3: illegal-click flash overlay ───────────────────── */}
        {regionEntries
          .filter((r) => r.isFlash)
          .map(({ id, d }) => (
            <path
              key={`flash-${id}`}
              d={d}
              className="cq-map-flash-overlay"
              fillRule="evenodd"
              aria-hidden="true"
            />
          ))}

        {/* ── Layer 3.5: capture glow (fill flash under labels) ─────── */}
        <g className="cq-map-capture-glow-layer" pointerEvents="none" aria-hidden="true">
          {ownershipFx.map((fx) => {
            const entry = regionEntries.find(e => e.id === fx.regionId);
            if (!entry) return null;
            const c = COLOR_MAP[fx.colorKey] ?? COLOR_MAP.neutral;
            return (
              <path
                key={`glow-${fx.id}`}
                d={entry.d}
                className="cq-map-capture-glow"
                fillRule="evenodd"
                fill={c.legalFill}
                stroke="none"
              />
            );
          })}
        </g>

        {/* ── Layer 3.6: bonus intro pulse (one-shot, ~2.5s) ───────────
             Region-shaped gold halo painted on the bonus region paths
             when the assignment first appears (match start) or its set
             changes.  Renders below labels/badges so the halo never
             obscures point values, and above the capture glow so a
             match starting with already-owned regions still highlights
             the bonus tiles cleanly. */}
        {bonusIntroFx.length > 0 && (
          <g
            className="cq-map-bonus-intro-layer"
            pointerEvents="none"
            aria-hidden="true"
          >
            {bonusIntroFx.map((rid) => {
              const entry = regionEntries.find(e => e.id === rid);
              if (!entry) return null;
              return (
                <path
                  key={`bonus-intro-${rid}`}
                  d={entry.d}
                  className="cq-map-bonus-intro-halo"
                  fillRule="evenodd"
                  fill="none"
                />
              );
            })}
          </g>
        )}

        {/* ── Layer 3.7: Liman ⚓ income pulse (per-tick, ~1.4s) ────────
             Re-fires the bonus halo on the Liman region every time the
             current owner earns an income tick.  Uses the same visual
             treatment as the bonus-intro halo so players read "this is
             the bonus region producing value" without learning a new FX. */}
        {limanIncomeFx.length > 0 && (
          <g
            className="cq-map-liman-income-layer"
            pointerEvents="none"
            aria-hidden="true"
          >
            {limanIncomeFx.map((rid, i) => {
              const entry = regionEntries.find(e => e.id === rid);
              if (!entry) return null;
              return (
                <path
                  key={`liman-fx-${rid}-${i}`}
                  d={entry.d}
                  className="cq-map-bonus-intro-halo"
                  fillRule="evenodd"
                  fill="none"
                />
              );
            })}
          </g>
        )}

        {/* ── Layer 4: region labels (always on top) ─────────────────── */}
        {regionEntries.map(({ id, owner, c, labelPos, label }) => {
          const labelY = owner ? labelPos.y - 7 : labelPos.y;
          return (
            <g key={`lbl-${id}`} aria-hidden="true" style={{ pointerEvents: "none" }}>
              <text
                x={labelPos.x}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="cq-map-label"
                style={{ fill: c.text, userSelect: "none" }}
              >
                {label}
              </text>
              {owner && (
                <text
                  x={labelPos.x}
                  y={labelPos.y + 9}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-owner-label"
                  style={{ fill: c.text, userSelect: "none" }}
                >
                  {owner.name}
                </text>
              )}
            </g>
          );
        })}

        {/* ── Layer 4a: open-shield overlay (İstanbul bonus) ──────── */}
        <g className="cq-map-shield-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries
            .filter(r => r.isShielded)
            .map(({ id, d }) => (
              <path
                key={`shield-${id}`}
                d={d}
                className="cq-map-shield-overlay"
                fillRule="evenodd"
                fill="none"
                strokeWidth={3}
              />
            ))}
        </g>

        {/* ── Layer 4b: bonus region badges (decorative; never intercepts clicks) ──
             Reads as a small strategic marker rather than a stray emoji:
             dark disc + thin gold rim + inner ring for depth, with the
             bonus glyph centered.  Sized so it lands clear of the value
             badge to its left (see `+ 26` offset below).  Hover on the
             host region path still surfaces the bonus label via the
             native <title> on the path — no extra pointer target is
             added here, so gameplay clicks stay untouched. */}
        <g className="cq-map-bonus-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, labelPos, bonus, isShielded, limanTicks, bereketTurns, bereketHarvested }) => {
            if (!bonus) return null;
            const off = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
            const cx  = labelPos.x + off.dx + 26;
            const cy  = labelPos.y + off.dy;
            const isIntro = bonusIntroFx.includes(id as ConquestRegionId);
            return (
              <g
                key={`bonus-${id}`}
                className="cq-map-bonus-chip"
                data-shielded={isShielded ? "" : undefined}
                data-intro={isIntro ? "" : undefined}
              >
                <circle cx={cx} cy={cy} r={10} className="cq-map-bonus-chip-bg" />
                <circle cx={cx} cy={cy} r={6.5} className="cq-map-bonus-chip-inner" />
                <text
                  x={cx}
                  y={cy + 0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-bonus-icon"
                >
                  {bonus.icon}
                </text>
                {limanTicks !== null && (
                  <g className="cq-map-liman-counter">
                    <rect
                      x={cx - 11}
                      y={cy + 8}
                      width={22}
                      height={9}
                      rx={4.5}
                      ry={4.5}
                      className="cq-map-liman-counter-bg"
                    />
                    <text
                      x={cx}
                      y={cy + 12.6}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="cq-map-liman-counter-text"
                    >
                      {`${limanTicks}/10`}
                    </text>
                  </g>
                )}
                {bereketTurns !== null && (
                  <g
                    className="cq-map-liman-counter cq-map-bereket-counter"
                    data-harvested={bereketHarvested ? "" : undefined}
                  >
                    <rect
                      x={cx - 11}
                      y={cy + 8}
                      width={22}
                      height={9}
                      rx={4.5}
                      ry={4.5}
                      className="cq-map-liman-counter-bg"
                    />
                    <text
                      x={cx}
                      y={cy + 12.6}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="cq-map-liman-counter-text"
                    >
                      {bereketHarvested ? "✓" : `${bereketTurns}/${BEREKET_HARVEST_INTERVAL}`}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* ── Layer 5: region point badges (decorative; never intercepts clicks) ── */}
        <g className="cq-map-points-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, labelPos, points, bonus }) => {
            if (!points) return null;
            const off  = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
            const cx   = labelPos.x + off.dx;
            const cy   = labelPos.y + off.dy;
            return (
              <g
                key={`pts-${id}`}
                className="cq-map-point-badge"
                data-bonus={bonus ? "" : undefined}
              >
                <circle cx={cx} cy={cy} r={8.5} className="cq-map-point-badge-ring" />
                <text
                  x={cx}
                  y={cy + 0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-point-badge-text"
                >
                  {points}
                </text>
              </g>
            );
          })}
        </g>

        {/* ── Layer 5.4: Pusu owner-only marker 🕳️ ──────────────────────
             Small dim halo + glyph at the region's label anchor for every
             region the LOCAL viewer has armed with a Pusu.  Opponents pass
             an empty `myAmbushRegionIds` set so this layer is unmounted on
             their map — the placement state stays secret until trigger. */}
        {myAmbushRegionIds && myAmbushRegionIds.size > 0 && (
          <g
            className="cq-map-ambush-owner-layer"
            pointerEvents="none"
            aria-hidden="true"
          >
            {regionEntries
              .filter(e => myAmbushRegionIds.has(e.id as ConquestRegionId))
              .map(({ id, labelPos }) => {
                const off = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
                // Anchor opposite the bonus chip (which sits at +26) so the
                // two never overlap when a region carries both.
                const cx  = labelPos.x + off.dx - 26;
                const cy  = labelPos.y + off.dy;
                return (
                  <g key={`ambush-own-${id}`} className="cq-map-ambush-owner-chip">
                    <circle cx={cx} cy={cy} r={10} className="cq-map-ambush-owner-chip-bg" />
                    <circle cx={cx} cy={cy} r={6.5} className="cq-map-ambush-owner-chip-inner" />
                    <text
                      x={cx}
                      y={cy + 0.5}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="cq-map-ambush-owner-icon"
                    >
                      🕳️
                    </text>
                  </g>
                );
              })}
          </g>
        )}

        {/* ── Layer 5.55: Sınır Karakolu (public outpost) chip ─────────
             Painted at the region's label anchor so it sits visually
             where the player would expect a "this region has something
             special" badge.  Public: identical layer for every viewer,
             no owner-side filter.  Distinct glyph (🏯) keeps it from
             being confused with the open shield (🛡️ via Layer 4a path
             overlay) or the Pusu owner chip (🕳️, owner-only).  Never
             intercepts pointer events. */}
        {borderOutpostRegions && borderOutpostRegions.size > 0 && (
          <g
            className="cq-map-outpost-layer"
            pointerEvents="none"
            aria-hidden="true"
          >
            {regionEntries
              .filter(e => borderOutpostRegions.has(e.id as ConquestRegionId))
              .map(({ id, labelPos }) => {
                const off = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
                // Anchor above the label so we don't fight the value
                // badge (offset 0,0) or the bonus chip (+26).  16px up
                // keeps it readable against owned + neutral fills.
                const cx  = labelPos.x + off.dx;
                const cy  = labelPos.y + off.dy - 18;
                return (
                  <g key={`outpost-${id}`} className="cq-map-outpost-chip">
                    <circle cx={cx} cy={cy} r={10} className="cq-map-bonus-chip-bg" />
                    <circle cx={cx} cy={cy} r={6.5} className="cq-map-bonus-chip-inner" />
                    <text
                      x={cx}
                      y={cy + 0.5}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="cq-map-bonus-icon"
                    >
                      🏯
                    </text>
                  </g>
                );
              })}
          </g>
        )}

        {/* ── Layer 5.5: Attack Focus target marker ─────────────────────
             Pulsing red ring + ⚔️ glyph at the region's label anchor.
             Active while `attackTargetRegionId` is non-null; cleared as
             soon as the parent unmounts the prop value, so the parent
             owns lifetime.  Never intercepts pointer events. */}
        {attackTargetRegionId && (() => {
          const entry = regionEntries.find(e => e.id === attackTargetRegionId);
          if (!entry) return null;
          const lbl = REGION_LABEL_POS[entry.id] ?? { x: 0, y: 0 };
          return (
            <g
              className="cq-map-attack-target-layer"
              pointerEvents="none"
              aria-hidden="true"
            >
              <path
                d={entry.d}
                className="cq-map-attack-target-ring"
                fillRule="evenodd"
                fill="none"
              />
              <g
  className="cq-map-attack-target-glyph-anchor"
  transform={`translate(${lbl.x} ${lbl.y - 4})`}
>
  <g className="cq-map-attack-target-glyph">
    <text
      x={0}
      y={0}
      textAnchor="middle"
      dominantBaseline="central"
    >
      ⚔️
    </text>
  </g>
</g>
            </g>
          );
        })()}

        {/* ── Layer 6: ownership-change impact ring (top-most, one-shot) ── */}
        <g className="cq-map-impact-layer" pointerEvents="none" aria-hidden="true">
          {ownershipFx.map((fx) => {
            const entry = regionEntries.find(e => e.id === fx.regionId);
            if (!entry) return null;
            const c = COLOR_MAP[fx.colorKey] ?? COLOR_MAP.neutral;
            return (
              <path
                key={`impact-${fx.id}`}
                d={entry.d}
                className="cq-map-impact-ring"
                fillRule="evenodd"
                fill="none"
                stroke={c.legalStroke}
              />
            );
          })}
        </g>

        {/* ── Layer 6.5: capital reveal FX (one-shot, ~1400ms) ─────────
             Two sublayers per fallen capital:
               · region-shaped golden halo on the path itself (pulse)
               · concentric ring + glyph anchored at the label position
             Layered above the regular impact ring so a capital capture
             reads ceremonial. Pointer events off; clipped by the SVG
             viewBox so it never escapes onto mobile chrome. */}
        <g className="cq-map-capital-layer" pointerEvents="none" aria-hidden="true">
          {capitalFx.map((fx) => {
            const entry = regionEntries.find(e => e.id === fx.regionId);
            if (!entry) return null;
            const lbl = REGION_LABEL_POS[entry.id] ?? { x: 0, y: 0 };
            return (
              <g key={`cap-${fx.id}`} className="cq-map-capital-fx">
                <path
                  d={entry.d}
                  className="cq-map-capital-halo"
                  fillRule="evenodd"
                  fill="none"
                />
                <g
                  className="cq-map-capital-anchor"
                  transform={`translate(${lbl.x} ${lbl.y})`}
                >
                  <circle r={6}  className="cq-map-capital-ring cq-map-capital-ring--1" />
                  <circle r={6}  className="cq-map-capital-ring cq-map-capital-ring--2" />
                  <circle r={3.2} className="cq-map-capital-core" />
                </g>
              </g>
            );
          })}
        </g>

        {/* ── Layer 7: shield-shatter FX (one-shot, ~900ms) ──────────
             Three sublayers per broken region:
               · region-shaped halo (gold/white pulse on the path itself)
               · radial crack lines emanating from the label anchor
               · shield glyph that brightens then fades
             Pointer events off; fires only on the breaking tick so it
             never lingers and never re-emits on the steady state.        */}
        <g className="cq-map-shield-shatter-layer" pointerEvents="none" aria-hidden="true">
          {shieldBreakFx.map((fx) => {
            const entry = regionEntries.find(e => e.id === fx.regionId);
            if (!entry) return null;
            const lbl = REGION_LABEL_POS[entry.id] ?? { x: 0, y: 0 };
            return (
              <g key={`shatter-${fx.id}`} className="cq-map-shield-shatter">
                <path
                  d={entry.d}
                  className="cq-map-shield-shatter-halo"
                  fillRule="evenodd"
                  fill="none"
                />
                <g
                  className="cq-map-shield-shatter-cracks"
                  transform={`translate(${lbl.x} ${lbl.y})`}
                >
                  {SHIELD_SHATTER_CRACKS.map(({ a, len }, i) => {
                    const rad = (a * Math.PI) / 180;
                    const x2  = Math.cos(rad) * len;
                    const y2  = Math.sin(rad) * len;
                    return (
                      <line
                        key={`crack-${i}`}
                        x1={0}
                        y1={0}
                        x2={x2}
                        y2={y2}
                        className="cq-map-shield-shatter-crack"
                        style={{ animationDelay: `${i * 16}ms` }}
                      />
                    );
                  })}
                </g>
                <text
                  x={lbl.x}
                  y={lbl.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="cq-map-shield-shatter-icon"
                >
                  🛡️
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
