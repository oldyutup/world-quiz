/**
 * Conquest (Kuşatma) — reward and cosmetics type stubs.
 *
 * Phase-3 scope: future-ready type shapes only.  No actual XP calculation,
 * no Gold spending, no reward distribution.  These types serve as data model
 * anchors so reward systems can be wired in without touching gameplay logic.
 *
 * ─── Gold rule (MUST be respected in all future implementations) ───────────
 * Gold MUST NEVER provide any gameplay advantage.
 *
 * Prohibited uses (even if technically possible):
 *   • Extra attack charges or shield recharges
 *   • Hints, time extensions, or second-answer attempts
 *   • Easier question categories or lower difficulty
 *   • Stronger or faster captures
 *
 * Permitted uses (cosmetics and fair entry systems only):
 *   • Room/map themes and visual overlays
 *   • Capture and victory animations
 *   • Player banners, badges, and profile titles
 *   • Equal-entry Gold prize pools (every participant pays the same fee)
 *   • Fair reward distribution at match end
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** XP preview shown in the lobby before a match starts. */
export interface ConquestXpConfig {
  /** Whether this match awards XP to participants. */
  xpEligible:       boolean;
  /** Base XP for participating (not winning). */
  participationXp:  number;
  /** Bonus XP awarded to the match winner. */
  winnerBonusXp:    number;
  /** Per-region-captured XP bonus (applied at match end). */
  perRegionXp:      number;
}

/**
 * Cosmetic hooks that Gold can unlock.
 * None of these fields affect region capture, question outcomes, or
 * any other gameplay mechanic.
 */
export interface ConquestGoldCosmeticsConfig {
  /** Optional cosmetic theme applied to the room's map board. */
  roomThemeId?:        string;
  /** Per-player banner displayed in the player-slot column. */
  playerBannerId?:     string;
  /** Animation played when a region is captured. */
  captureEffectId?:    string;
  /** Animation played when a region is shielded. */
  shieldEffectId?:     string;
  /** Animation played on the victory screen for the winner. */
  victoryEffectId?:    string;
}

/**
 * Optional equal-entry Gold prize pool.
 * All players must pay the same entry fee; the pool is split by rank at the
 * end of the match.  Pay-to-enter is only allowed when all entries are equal.
 */
export interface ConquestGoldPoolConfig {
  enabled:       boolean;
  /** Gold amount each player pays to enter.  Must be identical for all. */
  entryFee:      number;
  /** Total pool = entryFee × playerCount (computed, not stored). */
  prizePool:     number;
  /** Distribution percentages by rank (index 0 = 1st place). */
  distribution:  number[];
}

/**
 * Full reward preview shown in the lobby.
 * Surfaces XP estimates and Gold pool info before the match starts.
 */
export interface ConquestRewardPreview {
  xp:         ConquestXpConfig;
  cosmetics:  ConquestGoldCosmeticsConfig;
  goldPool?:  ConquestGoldPoolConfig;
}

/** Default XP config used when no override is provided. */
export const DEFAULT_CONQUEST_XP_CONFIG: ConquestXpConfig = {
  xpEligible:      true,
  participationXp: 10,
  winnerBonusXp:   25,
  perRegionXp:     2,
};
