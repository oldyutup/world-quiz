/**
 * Curated built-in profile avatars.
 *
 * IDs are stable and must never be reused for a different meaning — a stored
 * profile may reference an id long after the visuals change. Unknown / removed
 * ids fall back to the default globe image in Avatar.tsx.
 */

import avatarBoy01 from "../assets/avatars/avatar_boy_01.png";
import avatarWomanBrunette01 from "../assets/avatars/avatar_woman_brunette_01.png";
import avatarBoyBlack01 from "../assets/avatars/avatar_boy_black_01.png";
import avatarWomanBlack01 from "../assets/avatars/avatar_woman_black_01.png";
import avatarBoyBlonde01 from "../assets/avatars/avatar_boy_blonde_01.png";
import avatarWomanBlonde01 from "../assets/avatars/avatar_woman_blonde_01.png";
import avatarDefaultGlobe01 from "../assets/avatars/avatar_default_globe_01.png";

/** Globe image used as the default avatar for profiles with no / unknown selection. */
export { avatarDefaultGlobe01 as DEFAULT_AVATAR_IMAGE };

export interface AvatarDef {
  /** Stable id, persisted on profiles.avatar_id. */
  id: string;
  /** Short human label (Turkish), shown in the avatar picker. */
  label: string;
  /** Image asset URL rendered inside the circular avatar. */
  image: string;
}

export const AVATARS: readonly AvatarDef[] = [
  { id: "avatar_boy_01",           label: "Genç",   image: avatarBoy01 },
  { id: "avatar_woman_brunette_01", label: "Mira",   image: avatarWomanBrunette01 },
  { id: "avatar_boy_black_01",     label: "Kaşif",  image: avatarBoyBlack01 },
  { id: "avatar_woman_black_01",   label: "Nova",   image: avatarWomanBlack01 },
  { id: "avatar_boy_blonde_01",    label: "Gezgin", image: avatarBoyBlonde01 },
  { id: "avatar_woman_blonde_01",  label: "Işık",   image: avatarWomanBlonde01 },
] as const;

/**
 * Default avatar for profiles with no selection. null means "no avatar yet";
 * Avatar.tsx renders the default globe image in that case.
 */
export const DEFAULT_AVATAR_ID: string | null = null;

/** Look up an avatar by id. Returns undefined for unknown / legacy ids. */
export function getAvatar(id: string | null | undefined): AvatarDef | undefined {
  if (!id) return undefined;
  return AVATARS.find((a) => a.id === id);
}

/**
 * True only for currently selectable catalog avatars. Legacy / removed ids
 * return false and are rejected by updateAvatar.
 */
export function isValidAvatarId(id: string | null | undefined): boolean {
  return getAvatar(id) !== undefined;
}
