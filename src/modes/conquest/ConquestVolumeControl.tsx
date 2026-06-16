/**
 * ConquestVolumeControl — Kuşatma-only master volume button + slider.
 *
 * Tiny header control that toggles a popover with a 0–100% slider.  Writes
 * straight through to `setConquestMasterVolume` so every subsequent
 * `playConquestSound` call uses the updated multiplier.  Only Kuşatma FX
 * are affected; other modes' audio is untouched.
 *
 * The global mute switch (lib/sound.ts `isSoundEnabled`) still wins — this
 * slider scales volume *within* the unmuted range and never overrides mute.
 */

import { useEffect, useRef, useState } from "react";
import { EmojiIcon, type EmojiIconName } from "../../components/EmojiIcon";
import {
  getConquestMasterVolume,
  setConquestMasterVolume,
  subscribeConquestMasterVolume,
} from "./conquestSound";

interface Props {
  /** Visual variant — desktop header (round chip) vs mobile header (matches help "?"). */
  variant?: "desktop" | "mobile";
  /** Increment this value to force-close the popover from outside. */
  closeKey?: number;
  /** Called when the popover opens. Use to close sibling panels. */
  onOpen?: () => void;
}

function volumeIcon(v: number): EmojiIconName {
  if (v <= 0)    return "speaker-mute";
  if (v < 0.34)  return "speaker-low";
  if (v < 0.67)  return "speaker-med";
  return "speaker-high";
}

export default function ConquestVolumeControl({ variant = "desktop", closeKey, onOpen }: Props) {
  const [open,   setOpen]   = useState(false);
  const [volume, setVolume] = useState<number>(() => getConquestMasterVolume());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keep local state in sync if another component changes the master.
  useEffect(() => subscribeConquestMasterVolume(setVolume), []);

  // Force-close when parent increments closeKey.
  const prevCloseKey = useRef(closeKey);
  useEffect(() => {
    if (closeKey === undefined) return;
    if (closeKey !== prevCloseKey.current) {
      prevCloseKey.current = closeKey;
      setOpen(false);
    }
  }, [closeKey]);

  // Click-outside / Escape closes the popover.
  useEffect(() => {
    if (!open) return;

    function onPointer(ev: PointerEvent) {
      const root = wrapRef.current;
      if (!root) return;
      if (root.contains(ev.target as Node)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleSlide(ev: React.ChangeEvent<HTMLInputElement>) {
    const pct = Number.parseInt(ev.target.value, 10);
    const next = setConquestMasterVolume(pct / 100);
    setVolume(next);
  }

  const pct       = Math.round(volume * 100);
  const buttonCls = variant === "mobile" ? "mcq-header-volume" : "cq-volume-btn";

  return (
    <div className="cq-volume-wrap" ref={wrapRef}>
      <button
        type="button"
        className={buttonCls}
        onClick={() => setOpen(prev => {
          if (!prev) onOpen?.();
          return !prev;
        })}
        aria-label={`Kuşatma sesi: %${pct}`}
        aria-pressed={open}
        aria-expanded={open}
        title={`Kuşatma sesi: %${pct}`}
      >
        <span aria-hidden="true"><EmojiIcon name={volumeIcon(volume)} /></span>
      </button>

      {open && (
        <div
          className="cq-volume-popover"
          role="dialog"
          aria-label="Kuşatma ses ayarı"
        >
          <div className="cq-volume-popover-header">
            <span className="cq-volume-popover-title">Kuşatma sesi</span>
            <span className="cq-volume-popover-value">%{pct}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={handleSlide}
            className="cq-volume-slider"
            aria-label="Kuşatma ses seviyesi"
          />
          <p className="cq-volume-popover-hint">
            Sadece Kuşatma modunu etkiler.
          </p>
        </div>
      )}
    </div>
  );
}
