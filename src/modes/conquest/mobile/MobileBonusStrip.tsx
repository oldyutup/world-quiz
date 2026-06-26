/**
 * MobileBonusStrip — compact horizontal chip row that replaces the
 * auto-opening "Bu Maçtaki Bonuslar" modal on mobile.
 *
 * Renders one chip per active match bonus (icon + short label).  Tapping
 * a chip opens a small inline detail card directly below the strip with
 * the bonus name, region label, and a short effect description.  Only
 * one detail is open at a time; tapping another chip swaps the contents,
 * and tapping anywhere outside (including the map) closes it.
 *
 * Mobile-only consumer — never mounted on desktop, so styling lives in
 * the `.mcq-bonus-*` selector family without media-query gating.
 */

import { useEffect, useRef, useState } from "react";
import { BONUS_TYPE_EFFECT_COPY } from "../ConquestBonusGuide";
import type { ConquestBonusGuideEntry } from "../ConquestBonusGuide";
import type { ConquestRegionId } from "../types";

interface Props {
  entries: ConquestBonusGuideEntry[];
}

export default function MobileBonusStrip({ entries }: Props) {
  const [openId, setOpenId] = useState<ConquestRegionId | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close detail when the user taps outside the strip / detail card —
  // including the map, sheet handle, header, and toasts.
  useEffect(() => {
    if (openId === null) return;
    function onPointerDown(e: PointerEvent) {
      const root = wrapRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpenId(null);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openId]);

  // ESC also closes — matches the modal behaviour the user is used to.
  useEffect(() => {
    if (openId === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  if (entries.length === 0) return null;

  const active = openId !== null
    ? entries.find(e => e.regionId === openId) ?? null
    : null;
  const activeEffect = active
    ? BONUS_TYPE_EFFECT_COPY[active.def.type] ?? active.def.description
    : "";

  return (
    <div className="mcq-bonus-strip-wrap" ref={wrapRef}>
      <div
        className="mcq-bonus-strip"
        role="list"
        aria-label="Bu maçtaki bonuslar"
      >
        {entries.map(({ regionId, def }) => {
          const isOpen = openId === regionId;
          return (
            <button
              key={regionId}
              type="button"
              role="listitem"
              className={
                "mcq-bonus-chip" + (isOpen ? " mcq-bonus-chip--active" : "")
              }
              onClick={() => setOpenId(isOpen ? null : regionId)}
              aria-expanded={isOpen}
              aria-label={`${def.label} bonusu detayı`}
            >
              <span className="mcq-bonus-chip-icon" aria-hidden="true">
                {def.icon}
              </span>
              <span className="mcq-bonus-chip-label">{def.label}</span>
            </button>
          );
        })}
      </div>

      {active && (
        <div
          className="mcq-bonus-detail"
          role="dialog"
          aria-label={`${active.def.label} bonusu`}
        >
          <div className="mcq-bonus-detail-head">
            <span className="mcq-bonus-detail-icon" aria-hidden="true">
              {active.def.icon}
            </span>
            <span className="mcq-bonus-detail-title">{active.def.label}</span>
            <button
              type="button"
              className="mcq-bonus-detail-close"
              onClick={() => setOpenId(null)}
              aria-label="Bonus detayını kapat"
              title="Kapat"
            >
              ✕
            </button>
          </div>
          <div className="mcq-bonus-detail-region">{active.regionLabel}</div>
          <p className="mcq-bonus-detail-desc">{activeEffect}</p>
        </div>
      )}
    </div>
  );
}
