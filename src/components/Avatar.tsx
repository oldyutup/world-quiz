/**
 * Avatar.tsx — shared profile avatar renderer (Avatar Phase 1B).
 *
 * Renders one of two things from a profile's `avatar_id`:
 *   - a curated built-in avatar (emoji on its own gradient) when the id is a
 *     known catalog entry (see src/data/avatars.ts), or
 *   - the historic username-initial circle (blue→purple gradient) when the id
 *     is null / unknown, so profiles without a chosen avatar look exactly like
 *     they did before this feature.
 *
 * Sizing works two ways so it can drop into existing layouts unchanged:
 *   - pass `size` (px) → the component owns width/height/font-size inline
 *     (used by the picker grid), or
 *   - pass only `className` → all sizing comes from CSS (the dropdown reuses
 *     its existing `.upd-avatar` / `.upd-head-avatar` rules, including their
 *     responsive shrink), and the component only swaps the glyph/background.
 *
 * Pure presentational + no native-only APIs, so it renders identically on
 * desktop web and inside the native app shell.
 */
import type { CSSProperties } from "react";
import { getAvatar } from "../data/avatars";

/** Historic username-initial gradient — kept byte-identical to the old
 *  .upd-avatar / .upd-head-avatar background so unset profiles don't change. */
const FALLBACK_GRADIENT = "linear-gradient(135deg, #3b7de8, #7c3aed)";

interface AvatarProps {
  avatarId?: string | null;
  username?: string | null;
  /** Explicit pixel diameter. Omit to let `className` drive sizing. */
  size?: number;
  className?: string;
  title?: string;
}

export function Avatar({ avatarId, username, size, className, title }: AvatarProps) {
  const def = getAvatar(avatarId);
  const initial = ((username ?? "?").trim()[0] ?? "?").toUpperCase();

  const style: CSSProperties = {
    // Curated avatars carry their own gradient; otherwise keep the historic
    // username-initial gradient. Applied inline so it overrides any background
    // from a sizing className (e.g. .upd-avatar) without extra CSS.
    background: def ? def.gradient : FALLBACK_GRADIENT,
  };
  if (size != null) {
    style.width = size;
    style.height = size;
    style.borderRadius = "50%";
    style.fontSize = Math.round(size * 0.46);
  }

  return (
    <span
      className={`avatar${className ? ` ${className}` : ""}`}
      style={style}
      title={title}
    >
      {def ? (
        <span className="avatar-emoji" aria-hidden="true">
          {def.emoji}
        </span>
      ) : (
        initial
      )}
    </span>
  );
}
