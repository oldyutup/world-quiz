/** Local bots' average presses per second, in the order they join: average, fast, slow. */
export const BOT_PACES = [9, 12, 6] as const;
export const BOT_NAMES: Readonly<Record<number, string>> = { 6: "Yavaş Bot", 9: "Orta Bot", 12: "Hızlı Bot" };

/**
 * A local bot pressing at about `rate` a second. The pace drifts in two slow waves (tiring,
 * spurts) and every gap is a little uneven, like a person; it starts a moment after BAŞLA.
 */
export class ClickBot {
  private next: number;
  private readonly phase: [number, number];
  constructor(readonly rate: number, private readonly random: () => number = Math.random) {
    this.next = 180 + random() * 260;
    this.phase = [random() * Math.PI * 2, random() * Math.PI * 2];
  }
  /** The bot's pace at `ms` after BAŞLA. */
  pace(ms: number) {
    const t = ms / 1000;
    return this.rate * (1 + 0.12 * Math.sin((2 * Math.PI * t) / 5.5 + this.phase[0]) + 0.06 * Math.sin((2 * Math.PI * t) / 1.7 + this.phase[1]));
  }
  /** Presses made up to `ms` after BAŞLA, stamped when they were made. */
  presses(ms: number) {
    const out: number[] = [];
    while (this.next <= ms) {
      out.push(this.next);
      this.next += (1000 / this.pace(this.next)) * (0.8 + 0.4 * this.random());
    }
    return out;
  }
}
