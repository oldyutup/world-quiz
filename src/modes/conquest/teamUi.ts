/**
 * teamUi — Render-time helpers for 2v2 (teams_2v2) UI grouping.
 *
 * Pure presentation helpers used by the player panel and the finished
 * panel to surface "Mavi Takım" / "Kırmızı Takım" blocks.  No gameplay
 * logic lives here — every value is derived at render time from data
 * the screens already have (players, playerPoints, regionCounts).
 *
 * teamId convention (mirrors `types.ts`):
 *   1 → Mavi Takım
 *   2 → Kırmızı Takım
 */
import type {
  ConquestGameState,
  ConquestPlayer,
  ConquestRoomSettings,
  ConquestTeamId,
} from "./types";

/**
 * Gameplay-side check: true when the running match is in 2v2 team mode AND
 * the per-player teamId mapping is populated.  Mirrors `shouldUseTeamUi` but
 * sources from the game state (which carries `teamMode` + `teamAssignments`
 * after match start) so action validation can stay UI-agnostic.
 */
export function isTeamModeActive(state: ConquestGameState | null | undefined): boolean {
  if (!state) return false;
  if (state.teamMode !== "teams_2v2") return false;
  const a = state.teamAssignments;
  return !!a && Object.keys(a).length > 0;
}

/** Returns the player's teamId from state.teamAssignments, or null when unset. */
export function getPlayerTeamId(
  state:    ConquestGameState | null | undefined,
  playerId: string | null | undefined,
): ConquestTeamId | null {
  if (!state || !playerId) return null;
  return state.teamAssignments?.[playerId] ?? null;
}

/**
 * True when both players are on the same 2v2 team.  Returns false for the
 * same-player case (`a === b`) so callers can use it as a clean "is this a
 * friendly attack" guard without an extra self-check.  Returns false in
 * individual mode.
 */
export function areTeammates(
  state:     ConquestGameState | null | undefined,
  playerAId: string | null | undefined,
  playerBId: string | null | undefined,
): boolean {
  if (!isTeamModeActive(state)) return false;
  if (!playerAId || !playerBId) return false;
  if (playerAId === playerBId) return false;
  const a = getPlayerTeamId(state, playerAId);
  const b = getPlayerTeamId(state, playerBId);
  return a !== null && a === b;
}

export const CONQUEST_TEAM_IDS: ConquestTeamId[] = [2, 1];

export function getTeamLabel(teamId: ConquestTeamId): string {
  return teamId === 2 ? "Kırmızı Takım" : "Mavi Takım";
}

/** data-color token reused with the existing .cq-players-panel-row palette. */
export function getTeamAccent(teamId: ConquestTeamId): "red" | "blue" {
  return teamId === 2 ? "red" : "blue";
}

export interface TeamMemberSummary {
  id:      string;
  name:    string;
  points:  number;
  regions: number;
}

export interface TeamSummary {
  teamId:      ConquestTeamId;
  label:       string;
  accent:      "red" | "blue";
  totalPoints: number;
  totalRegions: number;
  members:     TeamMemberSummary[];
}

export function buildTeamSummaries(
  players:      ConquestPlayer[],
  playerPoints: Record<string, number>,
  regionCounts: Record<string, number>,
): TeamSummary[] {
  return CONQUEST_TEAM_IDS.map(teamId => {
    const members: TeamMemberSummary[] = players
      .filter(p => p.teamId === teamId)
      .map(p => ({
        id:      p.id,
        name:    p.name,
        points:  playerPoints[p.id] ?? 0,
        regions: regionCounts[p.id] ?? 0,
      }))
      .sort((a, b) => b.points - a.points);

    const totalPoints  = members.reduce((sum, m) => sum + m.points, 0);
    const totalRegions = members.reduce((sum, m) => sum + m.regions, 0);

    return {
      teamId,
      label: getTeamLabel(teamId),
      accent: getTeamAccent(teamId),
      totalPoints,
      totalRegions,
      members,
    };
  });
}

/**
 * Returns true when the 2v2 team-grouped UI should render.
 *
 * Guards (in order):
 *   1. settings.teamMode === "teams_2v2"
 *   2. At least one player has a valid teamId (1 or 2)
 *
 * Returns false on any guard failure so callers can fall back to the
 * original flat list/standings UI without further branching.  We do NOT
 * require exactly 4 players — late-join / spectator / reconnect states
 * may transiently show 1–4 players and the grouped panel still reads
 * better than the flat list in those cases.
 */
export function shouldUseTeamUi(
  settings: ConquestRoomSettings,
  players:  ConquestPlayer[],
): boolean {
  if (settings.teamMode !== "teams_2v2") return false;
  return players.some(p => p.teamId === 1 || p.teamId === 2);
}

export type TeamWinnerResult =
  | { kind: "winner"; teamId: ConquestTeamId; label: string; accent: "red" | "blue" }
  | { kind: "draw" };

/**
 * Picks the winning team by (totalPoints DESC, totalRegions DESC).  Ties
 * after both keys surface as a draw — gameplay-side `winnerPlayerId` is
 * irrelevant in 2v2 because XP attribution is still per-player.
 */
export function pickTeamWinner(summaries: TeamSummary[]): TeamWinnerResult {
  const nonEmpty = summaries.filter(s => s.members.length > 0);
  if (nonEmpty.length === 0) return { kind: "draw" };
  if (nonEmpty.length === 1) {
    const only = nonEmpty[0];
    return { kind: "winner", teamId: only.teamId, label: only.label, accent: only.accent };
  }
  const [a, b] = nonEmpty;
  if (a.totalPoints !== b.totalPoints) {
    const top = a.totalPoints > b.totalPoints ? a : b;
    return { kind: "winner", teamId: top.teamId, label: top.label, accent: top.accent };
  }
  if (a.totalRegions !== b.totalRegions) {
    const top = a.totalRegions > b.totalRegions ? a : b;
    return { kind: "winner", teamId: top.teamId, label: top.label, accent: top.accent };
  }
  return { kind: "draw" };
}
