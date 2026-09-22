/** Slot identity only; spawn positions belong to the arena map (shared/party-lab/maps). */
export const PLAYERS = [
  { id: 0, label: "Player 1", color: "#f6c773" },
  { id: 1, label: "Player 2", color: "#e985a2" },
  { id: 2, label: "Player 3", color: "#79bbed" },
] as const;

export type PlayerId = (typeof PLAYERS)[number]["id"];
