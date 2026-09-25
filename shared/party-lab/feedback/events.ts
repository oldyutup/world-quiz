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
  // Barn Shootout (rooftop never emits these).
  "weaponPickup",
  "shotgunFire",
  "smgFire",
  "bulletHit",
  "weaponEmpty",
  "trapSnap",
  "death",
  "respawn",
  // Bomba Sende (shared by local and authoritative online presentation).
  "bombTick",
  "bombPass",
  "bombBlast",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];
export interface FeedbackEvent {
  name: SfxName;
  intensity?: number; // 0..1, mapped from confirmed physical information
  x?: number;
  actor?: number;
  target?: number;
  step?: number; // countdown number
  /** Barn Shootout presentation detail (server-confirmed online); rooftop never sets it. */
  barn?: BarnEventDetail;
}
/**
 * What a client needs to draw a confirmed Barn shot or hit without re-deriving it:
 * compact integers (centimetres). Presentation only — HP, kills and deaths always come
 * from the snapshot.
 */
export interface BarnEventDetail {
  /** Shots: weapon code (1 shotgun, 2 SMG). */
  weapon?: number;
  /** Shots: where each pellet/round stopped, xyz per pellet (cm). */
  ends?: number[];
  /** Shots: per pellet, the slot it struck, −1 flew on, −2 stopped by the barn. */
  struck?: number[];
  /** Hits: damage dealt, the target's HP after, whether it killed. */
  damage?: number;
  hp?: number;
  killed?: boolean;
  /** Hits: where (xyz, cm). */
  point?: number[];
  /** Deaths: the credited killer (−1: nobody). */
  by?: number;
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
