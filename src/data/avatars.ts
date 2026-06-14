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

// ── Achievement avatar images (unlocked via gameplay; see achievementStats.ts) ──
import achievementWorldTraveler10 from "../assets/avatars/achievements/achievement_world_traveler_10.png";
import achievementWorldTraveler50 from "../assets/avatars/achievements/achievement_world_traveler_50.png";
import achievementWorldTraveler100 from "../assets/avatars/achievements/achievement_world_traveler_100.png";
import achievementFlagMaster25 from "../assets/avatars/achievements/achievement_flag_master_25.png";
import achievementFlagMaster100 from "../assets/avatars/achievements/achievement_flag_master_100.png";
import achievementFlagMaster250 from "../assets/avatars/achievements/achievement_flag_master_250.png";
import achievementStreakPlayer3 from "../assets/avatars/achievements/achievement_streak_player_3.png";
import achievementStreakPlayer5 from "../assets/avatars/achievements/achievement_streak_player_5.png";
import achievementStreakPlayer7 from "../assets/avatars/achievements/achievement_streak_player_7.png";
import achievementVersatilePlayer3 from "../assets/avatars/achievements/achievement_versatile_player_3.png";
import achievementVersatilePlayer5 from "../assets/avatars/achievements/achievement_versatile_player_5.png";
import achievementVersatilePlayer7 from "../assets/avatars/achievements/achievement_versatile_player_7.png";
import achievementWinStreak2 from "../assets/avatars/achievements/achievement_win_streak_2.png";
import achievementWinStreak3 from "../assets/avatars/achievements/achievement_win_streak_3.png";
import achievementWinStreak5 from "../assets/avatars/achievements/achievement_win_streak_5.png";

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
 * Achievement-unlocked avatars. IDs use the "avatar_ach_<tier>" form so the
 * profiles.avatar_id format CHECK ('^avatar_[a-z0-9_]{1,32}$') accepts them with
 * no migration. The id MUST equal achievementStats.avatarIdForTier(tier). These
 * are always *renderable* (so a saved unlocked avatar shows everywhere), but
 * only *selectable* when the matching achievement is unlocked — that gate lives
 * in the picker UI and in updateAvatar (see auth.ts), keyed off live stats.
 */
export const ACHIEVEMENT_AVATARS: readonly AvatarDef[] = [
  { id: "avatar_ach_world_traveler_10",   label: "Dünya Gezgini I",   image: achievementWorldTraveler10 },
  { id: "avatar_ach_world_traveler_50",   label: "Dünya Gezgini II",  image: achievementWorldTraveler50 },
  { id: "avatar_ach_world_traveler_100",  label: "Dünya Gezgini III", image: achievementWorldTraveler100 },
  { id: "avatar_ach_flag_master_25",      label: "Bayrak Ustası I",   image: achievementFlagMaster25 },
  { id: "avatar_ach_flag_master_100",     label: "Bayrak Ustası II",  image: achievementFlagMaster100 },
  { id: "avatar_ach_flag_master_250",     label: "Bayrak Ustası III", image: achievementFlagMaster250 },
  { id: "avatar_ach_streak_player_3",     label: "Seri Oyuncu I",     image: achievementStreakPlayer3 },
  { id: "avatar_ach_streak_player_5",     label: "Seri Oyuncu II",    image: achievementStreakPlayer5 },
  { id: "avatar_ach_streak_player_7",     label: "Seri Oyuncu III",   image: achievementStreakPlayer7 },
  { id: "avatar_ach_versatile_player_3",  label: "Çok Yönlü Oyuncu I",   image: achievementVersatilePlayer3 },
  { id: "avatar_ach_versatile_player_5",  label: "Çok Yönlü Oyuncu II",  image: achievementVersatilePlayer5 },
  { id: "avatar_ach_versatile_player_7",  label: "Çok Yönlü Oyuncu III", image: achievementVersatilePlayer7 },
  { id: "avatar_ach_win_streak_2",        label: "Seri Galibiyet I",   image: achievementWinStreak2 },
  { id: "avatar_ach_win_streak_3",        label: "Seri Galibiyet II",  image: achievementWinStreak3 },
  { id: "avatar_ach_win_streak_5",        label: "Seri Galibiyet III", image: achievementWinStreak5 },
] as const;

const ACHIEVEMENT_AVATAR_BY_ID: ReadonlyMap<string, AvatarDef> = new Map(
  ACHIEVEMENT_AVATARS.map((a) => [a.id, a])
);

/**
 * Default avatar for profiles with no selection. null means "no avatar yet";
 * Avatar.tsx renders the default globe image in that case.
 */
export const DEFAULT_AVATAR_ID: string | null = null;

/** Look up an avatar by id (curated OR achievement). Undefined for legacy ids. */
export function getAvatar(id: string | null | undefined): AvatarDef | undefined {
  if (!id) return undefined;
  return AVATARS.find((a) => a.id === id) ?? ACHIEVEMENT_AVATAR_BY_ID.get(id);
}

/**
 * True for any known selectable-or-renderable avatar id (curated catalog or an
 * achievement avatar). updateAvatar additionally enforces that achievement
 * avatars are actually unlocked before persisting. Legacy / removed ids → false.
 */
export function isValidAvatarId(id: string | null | undefined): boolean {
  return getAvatar(id) !== undefined;
}
