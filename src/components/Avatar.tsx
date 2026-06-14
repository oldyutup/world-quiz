/**
 * Avatar.tsx — shared profile avatar renderer.
 *
 * Renders the image for a profile's avatar_id. Unknown / null / legacy ids all
 * fall back to the default globe image so the UI is never broken by removed
 * catalog entries. No emoji or initial-letter fallback.
 *
 * Sizing works two ways:
 *   - pass `size` (px) → the component owns width/height/font-size inline
 *     (used by the picker grid), or
 *   - pass only `className` → all sizing comes from CSS (the dropdown reuses
 *     its existing rules), and the component only swaps the image.
 */
import type { CSSProperties } from "react";
import { getAvatar, DEFAULT_AVATAR_IMAGE } from "../data/avatars";

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
  const imgSrc = def?.image ?? DEFAULT_AVATAR_IMAGE;

  const style: CSSProperties = { background: "transparent" };
  if (size != null) {
    style.width = size;
    style.height = size;
    style.borderRadius = "50%";
  }

  return (
    <span
      className={`avatar${className ? ` ${className}` : ""}`}
      style={style}
      title={title}
    >
      <img
        className="avatar-img"
        src={imgSrc}
        alt={def?.label ?? (username ?? "avatar")}
        aria-hidden="true"
      />
    </span>
  );
}
