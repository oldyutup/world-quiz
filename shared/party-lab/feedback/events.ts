/** Semantic feedback only: no browser/audio nodes and no device bindings. */
export const SFX_NAMES = [
  "punchSwing",
  "bodyHit",
  "headHit",
  "limbHit",
  "lightBump",
  "heavyBump",
  "floorFlop",
  "grab",
  "secondGrab",
  "gripBreak",
  "lift",
  "release",
  "throw",
  "fall",
  "knockout",
  "recovery",
  "jump",
  "landing",
  "countdown",
  "roundStart",
  "winner",
  "draw",
  "uiClick",
  "uiConfirm",
  "uiBack",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];
export interface FeedbackEvent {
  name: SfxName;
  intensity?: number; // 0..1, mapped from confirmed physical information
  x?: number;
  actor?: number;
  target?: number;
  step?: number; // countdown number
}
export type FeedbackSink = (event: FeedbackEvent) => void;
export const silentFeedback: FeedbackSink = () => {};
export const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const impactLevel = (strength: number) =>
  strength >= 0.7 ? "HEAVY" : strength >= 0.35 ? "MEDIUM" : "LIGHT";
export const hitSound = (part: string): SfxName =>
  part === "head"
    ? "headHit"
    : part === "torso" || part === "pelvis"
    ? "bodyHit"
    : "limbHit";
export const collisionStrength = (speed: number, impulse: number) =>
  clamp01(Math.max(speed / 8, impulse / 3));
export const stereoPan = (x = 0) => Math.max(-0.65, Math.min(0.65, x / 12));
