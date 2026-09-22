import { impactLevel, type FeedbackEvent } from "./events";
/** Camera-only offset, never fed back to physics. No accumulation or gameplay RNG. */
export class CameraFeel {
  private remaining = 0;
  private strength = 0;
  trigger(event: FeedbackEvent) {
    const local = event.actor === 0 || event.target === 0;
    const impact = [
      "headHit",
      "bodyHit",
      "heavyBump",
      "floorFlop",
      "knockout",
    ].includes(event.name);
    if (!local || !impact || impactLevel(event.intensity ?? 0) !== "HEAVY")
      return;
    this.remaining = 0.15;
    this.strength = event.name === "knockout" ? 0.035 : 0.022;
  }
  step(dt: number, enabled: boolean): [number, number] {
    if (!enabled) this.clear();
    this.remaining = Math.max(0, this.remaining - dt);
    const envelope = (this.remaining / 0.15) ** 2 * this.strength;
    return [
      Math.sin(this.remaining * 130) * envelope,
      Math.sin(this.remaining * 170) * envelope * 0.55,
    ];
  }
  clear() {
    this.remaining = this.strength = 0;
  }
}
