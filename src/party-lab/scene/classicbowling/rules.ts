import { CLASSIC } from './config';
export interface FrameScore { rolls: number[]; kind: 'strike' | 'spare' | 'open' | null }
export class ClassicScore {
  seat = 0;
  frame = 0;
  roll: 1 | 2 = 1;
  finished = false;
  readonly cards: FrameScore[][];
  constructor(readonly count: 2 | 3) {
    if (count !== 2 && count !== 3) throw Error('Classic Bowling supports two or three local seats');
    this.cards = Array.from({ length: count }, () => Array.from({ length: CLASSIC.frames }, () => ({ rolls: [], kind: null })));
  }
  get totals() { return this.cards.map(card => card.reduce((s, f) => s + f.rolls.reduce((a, b) => a + b, 0), 0)); }
  get winners() { const scores = this.totals; return this.finished ? scores.flatMap((s, i) => s === Math.max(...scores) ? [i] : []) : []; }
  record(pins: number) {
    if (this.finished) throw Error('Match already finished');
    const current = this.cards[this.seat][this.frame];
    const remaining = 10 - current.rolls.reduce((a, b) => a + b, 0);
    if (!Number.isInteger(pins) || pins < 0 || pins > remaining || current.rolls.length !== this.roll - 1) throw Error('Invalid roll score');
    current.rolls.push(pins);
    current.kind = this.roll === 1 && pins === 10 ? 'strike' : this.roll === 2 ? (pins === remaining ? 'spare' : 'open') : null;
    return current.kind;
  }
  advance() {
    const current = this.cards[this.seat][this.frame];
    if (current.rolls.length !== this.roll) throw Error('Score the roll before advancing');
    if (this.roll === 1 && current.kind !== 'strike') { this.roll = 2; return 'spare' as const; }
    this.roll = 1;
    this.seat++;
    if (this.seat === this.count) { this.seat = 0; this.frame++; }
    if (this.frame === CLASSIC.frames) { this.finished = true; return 'finished' as const; }
    return 'rack' as const;
  }
}
