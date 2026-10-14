export const ACTIONS = [
  "moveForward",
  "moveBackward",
  "moveLeft",
  "moveRight",
  "jump",
  "punch",
  "grab",
  "lift",
] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_LABELS: Record<Action, string> = {
  moveForward: "Hareket İleri",
  moveBackward: "Hareket Geri",
  moveLeft: "Sola Git",
  moveRight: "Sağa Git",
  jump: "Zıpla",
  punch: "Yumruk",
  grab: "Tut",
  lift: "Kaldır",
};
/** Barn meanings of shared bindings (same key, other gameplay): see scene/arenas/barnControls.ts. */
export const BARN_ACTION_LABELS: Partial<Record<Action, string>> = {
  punch: "Saldır (yumruk / ateş)",
  grab: "Silah al",
  lift: "Koş",
};

/** Hediye Kapmaca's meaning of a shared binding: Tut takes a box (pile, floor or a rival's home). */
export const GIFT_ACTION_LABELS: Partial<Record<Action, string>> = {
  grab: "Kutu al",
};

/** Device-free human intent. Edges (jump/punch) are consumed once per physics step. */
export interface ActionIntent {
  x: number;
  z: number;
  jump: boolean;
  punch: boolean;
  grab: boolean;
  lift: boolean;
}
