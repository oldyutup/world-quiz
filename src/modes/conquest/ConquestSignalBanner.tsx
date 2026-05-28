/**
 * ConquestSignalBanner — single-slot cinematic banner.
 *
 * Renders one MAJOR or CRITICAL signal at a time, centered, brief,
 * gameplay-safe (pointer-events: none). MINOR signals stay in the
 * ConquestEventFeed and never reach this component.
 *
 * Tier and per-player color are pure CSS hooks via data-attributes, so
 * future signal kinds (capital_fell, player_eliminated, …) plug in
 * without touching the renderer — just add a new ConquestSignalKind and
 * a detector in useConquestSignals.
 *
 * Animation duration is data-driven (--cq-signal-ttl) so the same
 * keyframe handles both 1500ms major and 2400ms critical without
 * branching.
 */

import type { CSSProperties } from "react";
import type { ConquestSignal } from "./useConquestSignals";

interface Props {
  signal: ConquestSignal | null;
}

export default function ConquestSignalBanner({ signal }: Props) {
  if (!signal) return null;
  if (signal.tier === "minor") return null;

  const style = {
    ["--cq-signal-ttl" as string]: `${signal.ttlMs}ms`,
  } as CSSProperties;

  return (
    <div
      // key by id so React fully remounts on each new signal — the CSS
      // animation re-runs from frame 0 every time without manual reset.
      key={signal.id}
      className="cq-signal-banner"
      data-tier={signal.tier}
      data-kind={signal.kind}
      data-color={signal.colorKey ?? undefined}
      style={style}
      role="status"
      aria-live="polite"
    >
      <span className="cq-signal-banner__icon" aria-hidden="true">
        {signal.icon}
      </span>
      <span className="cq-signal-banner__title">{signal.title}</span>
      {signal.subtitle && (
        <span className="cq-signal-banner__subtitle">{signal.subtitle}</span>
      )}
    </div>
  );
}
