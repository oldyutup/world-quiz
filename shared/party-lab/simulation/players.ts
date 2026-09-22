/** Equal-radius, equilateral spawns, clear of each other and the fixed bumpers. */
export const PLAYERS = [
  {
    id: 0,
    label: "Player 1",
    color: "#f6c773",
    spawn: { x: 1.5, y: 1.6, z: 2.598 },
  },
  {
    id: 1,
    label: "Player 2",
    color: "#e985a2",
    spawn: { x: -3, y: 1.6, z: 0 },
  },
  {
    id: 2,
    label: "Player 3",
    color: "#79bbed",
    spawn: { x: 1.5, y: 1.6, z: -2.598 },
  },
] as const;

export type PlayerId = (typeof PLAYERS)[number]["id"];
