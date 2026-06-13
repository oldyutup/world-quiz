/**
 * Curated built-in profile avatars (Avatar Phase 1A).
 *
 * v1 keeps avatars as emoji + CSS gradient pairs — no image assets, so the same
 * catalog renders identically on desktop web and the native app with zero
 * network cost. The DB only enforces the `avatar_id` *format*
 * (`^avatar_[a-z0-9_]{1,32}$`); catalog membership is enforced here on the
 * client (isValidAvatarId), so adding/removing avatars never needs a migration.
 *
 * IDs are stable and must never be reused for a different meaning — a stored
 * profile may reference an id long after the visuals change.
 */

export interface AvatarDef {
  /** Stable id, persisted on profiles.avatar_id. Matches the DB format check. */
  id: string;
  /** Emoji rendered as the avatar glyph. */
  emoji: string;
  /** CSS gradient used as the avatar background (e.g. for `background`). */
  gradient: string;
  /** Short human label (Turkish), shown in the avatar picker. */
  label: string;
}

export const AVATARS: readonly AvatarDef[] = [
  {
    id: "avatar_globe_01",
    emoji: "🌍",
    gradient: "linear-gradient(135deg, #43cea2 0%, #185a9d 100%)",
    label: "Dünya",
  },
  {
    id: "avatar_compass_01",
    emoji: "🧭",
    gradient: "linear-gradient(135deg, #c94b4b 0%, #4b134f 100%)",
    label: "Pusula",
  },
  {
    id: "avatar_flag_01",
    emoji: "🚩",
    gradient: "linear-gradient(135deg, #ee0979 0%, #ff6a00 100%)",
    label: "Bayrak",
  },
  {
    id: "avatar_map_01",
    emoji: "🗺️",
    gradient: "linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)",
    label: "Harita",
  },
  {
    id: "avatar_plane_01",
    emoji: "✈️",
    gradient: "linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)",
    label: "Uçak",
  },
  {
    id: "avatar_ship_01",
    emoji: "🚢",
    gradient: "linear-gradient(135deg, #1a2980 0%, #26d0ce 100%)",
    label: "Gemi",
  },
  {
    id: "avatar_mountain_01",
    emoji: "⛰️",
    gradient: "linear-gradient(135deg, #606c88 0%, #3f4c6b 100%)",
    label: "Dağ",
  },
  {
    id: "avatar_castle_01",
    emoji: "🏰",
    gradient: "linear-gradient(135deg, #8e2de2 0%, #4a00e0 100%)",
    label: "Kale",
  },
  {
    id: "avatar_star_01",
    emoji: "⭐",
    gradient: "linear-gradient(135deg, #f7b733 0%, #fc4a1a 100%)",
    label: "Yıldız",
  },
  {
    id: "avatar_telescope_01",
    emoji: "🔭",
    gradient: "linear-gradient(135deg, #243949 0%, #517fa4 100%)",
    label: "Teleskop",
  },
] as const;

/**
 * Default avatar for profiles with no selection. null means "no avatar yet" —
 * callers fall back to their existing initial-letter rendering.
 */
export const DEFAULT_AVATAR_ID: string | null = null;

/** Look up an avatar by id. Returns undefined for unknown / legacy ids. */
export function getAvatar(id: string | null | undefined): AvatarDef | undefined {
  if (!id) return undefined;
  return AVATARS.find((a) => a.id === id);
}

/**
 * True when `id` is a known curated avatar. This is stricter than the DB
 * format check on purpose: in v1 only catalog avatars are selectable. null is
 * NOT valid here — callers that allow resetting to default handle null
 * separately (see updateAvatar).
 */
export function isValidAvatarId(id: string | null | undefined): boolean {
  return getAvatar(id) !== undefined;
}
