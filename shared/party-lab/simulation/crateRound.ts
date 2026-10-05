import type { MovementInput } from '../intent.js';
import { NET, type GameSnapshot, type OnlinePhase } from '../network/protocol.js';
import { CrateRainGame } from './craterain/game.js';
import { CRATE_RAIN as C, IDLE } from './craterain/config.js';
import { crateSection, crateTransforms } from './craterain/wire.js';
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from './online.js';
import type { PlayerId } from './players.js';
export class CrateRoundSimulation implements OnlineSimulation {
  readonly mode = 'crate_rain' as const;
  phase: OnlinePhase = 'waiting'; mask = 0; game: CrateRainGame;
  private sequences: number[] = []; private held: number[] = [];
  seats: PlayerId[] = []; readonly forfeits = new Set<number>(); private resultTime = 0;
  constructor(readonly counters: RoomCounters = newRoomCounters(), private seed = 71) { this.game = new CrateRainGame(2, seed); this.game.bots = false; }
  get tick() { return this.counters.tick; } get roundId() { return this.counters.round; }
  get seconds() { return this.phase === 'countdown' ? Math.max(0, C.countdown - this.game.phaseTime) : this.phase === 'results' ? Math.max(0, 10 - this.resultTime) : 0; }
  get winner() { const wins = this.game.wins, best = Math.max(...wins), ids = wins.flatMap((n, i) => n === best ? [i] : []); return this.phase === 'results' && ids.length === 1 ? this.seats[ids[0]] : -1; }
  start(slots: readonly PlayerId[]) {
    if (this.phase !== 'waiting' || slots.length < 2 || slots.length > 3 || new Set(slots).size !== slots.length || slots.some(s => !Number.isInteger(s) || s < 0 || s > 2)) return false;
    this.seats = [...slots].sort((a,b) => a-b); this.mask = slots.reduce<number>((m,s) => m | 1 << s, 0); this.forfeits.clear(); this.sequences = slots.map(() => -1); this.held = slots.map(() => 0);
    this.game.dispose(); this.game = new CrateRainGame(slots.length as 2|3, this.seed++); this.game.bots = false;
    this.counters.round++; this.phase = 'countdown'; this.resultTime = 0; return true;
  }
  cancelCountdown() { if (this.phase === 'countdown') { this.phase = 'waiting'; this.mask = 0; } }
  neutralize(_slot: PlayerId) { /* Mailbox cleared by room. Same body survives grace. */ }
  remove(slot: PlayerId) { const i = this.seats.indexOf(slot); if (i >= 0) { this.forfeits.add(i); this.game.players[i].alive = false; this.game.players[i].body.setEnabled(false); } }
  step(inputs: readonly MovementInput[]) {
    this.counters.tick++; if (this.phase === 'waiting') return [];
    if (this.phase === 'results') { if ((this.resultTime += 1/60) >= 10) { this.phase = 'waiting'; this.mask = 0; } return []; }
    this.seats.forEach((slot,i) => { const seq = inputs[slot]?.crate?.seq ?? -1; this.held[i] = seq === this.sequences[i] ? this.held[i] + 1 : 0; this.sequences[i] = seq; });
    for (let sub = 0; sub < 2; sub++) {
      const g = this.game, stage = g.round;
      g.step(IDLE, this.seats.map((slot, i) => { const p = inputs[slot]?.crate; return p && p.stage === g.round && !this.forfeits.has(i) ? { x:p.moveX, z:p.moveZ, jump:p.jumpHeld, sprint:p.sprintHeld } : IDLE; }));
      if (g.round !== stage) for (const i of this.forfeits) { g.players[i].alive = false; g.players[i].body.setEnabled(false); }
      if (this.phase === 'countdown' && g.phase !== 'countdown') this.phase = 'playing';
      if (g.phase === 'results') { this.phase = 'results'; this.resultTime = 0; break; }
    }
    return [];
  }
  snapshot(ack: number[]): GameSnapshot { return { v:NET.version, mode:this.mode, seq:++this.counters.snapshot, tick:this.tick, round:this.roundId, phase:this.phase, seconds:this.seconds, winner:this.winner, mask:this.mask,
    alive:this.game.players.reduce((m,p,i) => m | (p.alive ? 1 << this.seats[i] : 0), 0), states:[], meters:[], grips:[], ack, transforms:crateTransforms(this.game), crate:{...crateSection(this.game,this.seats),held:[...this.held]} }; }
  prediction(slot: PlayerId) { return { slot, velocities:new Uint8Array(), controller:[] }; }
  dispose() { this.game.dispose(); }
}
