/**
 * ConquestBonusBriefing — round-1 bonus briefing that plays INSIDE the tail
 * of the existing 9s game-intro window (desktop only).
 *
 * Sequence: for each of the top `BRIEFING_MAX_DETAIL` bonuses (priority
 * ranked), spotlight the region on the map (`onFocusRegion`) and show a small
 * info card (icon + label + region + one-line effect).  When the match has
 * more than four bonuses, the remaining ones collapse into a single summary
 * beat of compact chips.  Total runtime never exceeds ~6s and, because the
 * flow reuses the server-anchored intro window, it adds ZERO delay before
 * the first question.
 *
 * Pure presentational component: no game state is written, no sync fields
 * touched.  The parent mounts it for the briefing window and unmounts it when
 * the 3-2-1 countdown begins; unmount clears the map spotlight.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ConquestBonusIcon } from "./ConquestAssetIcon";
import { getBonusPoolEntry, type BonusCategory } from "./bonusPool";
import type { ConquestBonusGuideEntry } from "./ConquestBonusGuide";
import type { ConquestRegionBonusType, ConquestRegionId } from "./types";

/** Per-beat durations.  Chosen so the worst case (3 detail + 1 summary, or
 *  4 detail) lands just under the 6s ceiling the flow promises. */
const DETAIL_BEAT_MS  = 1450;
const SUMMARY_BEAT_MS = 1400;
/** Bonuses introduced with a full detail beat; the rest are summarised. */
const BRIEFING_MAX_DETAIL = 3;

/** Priority order for "en önemli" ranking — combat-rule-changing bonuses
 *  first, quality-of-life info bonuses last.  Types missing from this list
 *  sort after every listed one (stable). */
const BRIEFING_PRIORITY: readonly ConquestRegionBonusType[] = [
  "istanbul_defense",
  "kocbasi",
  "ankara_hidden_shield",
  "mancinik",
  "mevzi_bekcisi",
  "liman",
  "cukurova_score",
  "kahin",
  "istihbarat_agi",
  "karadeniz_extra_time",
  "eleme_yetkisi",
];

/** One-line effect copy sized for a ~1.4s read.  Longer canonical copy stays
 *  in ConquestBonusGuide (BONUS_TYPE_EFFECT_COPY); this map is deliberately
 *  terse.  Falls back to `def.description` for unknown types. */
const BRIEFING_EFFECT_COPY: Partial<Record<ConquestRegionBonusType, string>> = {
  istanbul_defense:     "Fethedene kalkan: ilk saldırı bölgeyi değil kalkanı kırar.",
  ankara_hidden_shield: "Fethedene gizli kalkan ya da gizli fetih hakkı verir.",
  cukurova_score:       "Fethedene +2 puan; 3 tur elde tutana +4 hasat.",
  karadeniz_extra_time: "Soru süresine +5 saniye ekler.",
  eleme_yetkisi:        "Sonraki test sorusunda 1 yanlış şık silinir.",
  mevzi_bekcisi:        "Bölgeyi kaybetsen bile puanı sende kalır.",
  kocbasi:              "Kalkanları aşar; rakip bölge fethine +1 puan.",
  mancinik:             "Tek seferlik uzak saldırı — komşuluk şartı yok.",
  liman:                "Sahibine her tur +1 puan ve +5 Gold (10 tura kadar).",
  kahin:                "Sıradaki sorunun türünü önceden gösterir.",
  istihbarat_agi:       "Rakiplerin gizli hamlelerini rapor eder.",
};

const CATEGORY_LABELS: Record<BonusCategory, string> = {
  savunma: "Savunma",
  saldiri: "Saldırı",
  bilgi:   "Bilgi",
  ekonomi: "Ekonomi",
};

interface BriefingBeat {
  kind:        "detail" | "summary";
  durationMs:  number;
  /** detail beats */
  entry?:      ConquestBonusGuideEntry;
  index?:      number;
  detailCount?: number;
  /** summary beat */
  rest?:       ConquestBonusGuideEntry[];
}

function priorityIndex(type: ConquestRegionBonusType): number {
  const i = BRIEFING_PRIORITY.indexOf(type);
  return i === -1 ? BRIEFING_PRIORITY.length : i;
}

/** Rank entries most-important-first (stable for equal priority). */
export function rankBriefingEntries(
  entries: ConquestBonusGuideEntry[],
): ConquestBonusGuideEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      priorityIndex(a.e.def.type) - priorityIndex(b.e.def.type) || a.i - b.i)
    .map(({ e }) => e);
}

function buildBriefingBeats(entries: ConquestBonusGuideEntry[]): BriefingBeat[] {
  const ranked = rankBriefingEntries(entries);
  // Up to four bonuses: every one earns a detail beat (4 × 1450ms = 5.8s).
  // Five or more: top three in detail, the rest in one summary beat.
  const detailCount = ranked.length <= 4
    ? ranked.length
    : BRIEFING_MAX_DETAIL;
  const beats: BriefingBeat[] = ranked.slice(0, detailCount).map((entry, index) => ({
    kind: "detail" as const,
    durationMs: DETAIL_BEAT_MS,
    entry,
    index,
    detailCount,
  }));
  if (ranked.length > detailCount) {
    beats.push({
      kind:       "summary",
      durationMs: SUMMARY_BEAT_MS,
      rest:       ranked.slice(detailCount),
    });
  }
  return beats;
}

/** Total briefing runtime for N active bonuses — the parent uses this to
 *  carve the briefing slot out of the game-intro window.  0 disables. */
export function briefingTotalMs(count: number): number {
  if (count <= 0) return 0;
  if (count <= 4) return count * DETAIL_BEAT_MS;
  return BRIEFING_MAX_DETAIL * DETAIL_BEAT_MS + SUMMARY_BEAT_MS;
}

interface Props {
  entries:       ConquestBonusGuideEntry[];
  /** Map spotlight setter — detail beats pass their regionId, the summary
   *  beat and unmount pass null. */
  onFocusRegion: (regionId: ConquestRegionId | null) => void;
}

export default function ConquestBonusBriefing({ entries, onFocusRegion }: Props) {
  // The parent rebuilds `entries` every ticker render; key the beat plan by
  // content so the timeline never resets mid-flight on identical input.
  const entriesKey = entries.map(e => `${e.regionId}:${e.def.type}`).join("|");
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const beats = useMemo(
    () => buildBriefingBeats(entriesRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entriesKey],
  );

  const [beatIndex, setBeatIndex] = useState(0);
  const onFocusRef = useRef(onFocusRegion);
  onFocusRef.current = onFocusRegion;

  useEffect(() => { setBeatIndex(0); }, [beats]);

  // Drive the beat chain with local timeouts (finer than the shared game
  // ticker).  The last beat holds until the parent unmounts the component
  // at countdown start, so no onDone plumbing is needed.
  useEffect(() => {
    const beat = beats[beatIndex];
    if (!beat) return;
    onFocusRef.current(beat.kind === "detail" ? beat.entry!.regionId : null);
    if (beatIndex >= beats.length - 1) return;
    const h = window.setTimeout(() => setBeatIndex(i => i + 1), beat.durationMs);
    return () => window.clearTimeout(h);
  }, [beatIndex, beats]);

  // Unmount always clears the map spotlight.
  useEffect(() => () => { onFocusRef.current(null); }, []);

  const beat = beats[beatIndex];
  if (!beat) return null;

  if (beat.kind === "detail") {
    const { entry, index = 0, detailCount = 1 } = beat;
    if (!entry) return null;
    const cat    = getBonusPoolEntry(entry.def.type)?.category ?? null;
    const effect = BRIEFING_EFFECT_COPY[entry.def.type] ?? entry.def.description;
    return (
      <div
        className="cq-duel-overlay-toast cq-bonus-briefing-overlay"
        role="status"
        aria-live="polite"
      >
        <div key={`detail-${index}`} className="cq-bonus-briefing-beat">
          <span className="cq-bonus-briefing-icon" aria-hidden="true">
            <ConquestBonusIcon
              type={entry.def.type}
              fallbackChar={entry.def.icon}
              size={34}
            />
          </span>
          <div className="cq-bonus-briefing-text">
            <div className="cq-bonus-briefing-kicker">
              Maç bonusu {index + 1}/{detailCount}
              {cat ? ` · ${CATEGORY_LABELS[cat]}` : ""}
            </div>
            <div className="cq-bonus-briefing-title">
              {entry.def.label}
              <span className="cq-bonus-briefing-region"> · {entry.regionLabel}</span>
            </div>
            <div className="cq-bonus-briefing-effect">{effect}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="cq-duel-overlay-toast cq-bonus-briefing-overlay"
      role="status"
      aria-live="polite"
    >
      <div key="summary" className="cq-bonus-briefing-beat">
        <div className="cq-bonus-briefing-text">
          <div className="cq-bonus-briefing-kicker">Diğer bonuslar</div>
          <div className="cq-bonus-briefing-chips">
            {(beat.rest ?? []).map(e => (
              <span key={e.regionId} className="cq-bonus-briefing-chip">
                <ConquestBonusIcon
                  type={e.def.type}
                  fallbackChar={e.def.icon}
                  size={15}
                />
                <span>{e.def.label} · {e.regionLabel}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
