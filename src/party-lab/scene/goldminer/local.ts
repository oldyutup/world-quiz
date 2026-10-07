import { GOLD_MINER as G } from "../../../../shared/party-lab/simulation/goldminer/config";
import { GoldMinerGame, type GoldShot } from "../../../../shared/party-lab/simulation/goldminer/game";
import { goldSection } from "../../../../shared/party-lab/simulation/goldminer/wire";
import { BOT_LEVEL_NAMES, GoldBot, type BotLevel } from "./bots";
import { canFire, type GoldFrame, type GoldSource } from "./online";
import type { GoldLaneLook } from "./visual";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type SelectableCostumeId } from "../visual/costumes";

const STEP = 1 / G.hz;
/**
 * Yerel Test Arenası: the server's rules (GoldMinerGame, a fresh random mine) run here, with
 * the player in lane 0 and bots in the others. It pauses while the menu is open.
 */
export class LocalGoldMiner implements GoldSource {
  readonly game: GoldMinerGame;
  readonly bots: GoldBot[];
  private acc = 0;
  private shot: GoldShot | null = null;
  constructor(readonly lanes: number, level: BotLevel, random: () => number = Math.random) {
    this.game = new GoldMinerGame(lanes, random);
    this.bots = Array.from({ length: lanes - 1 }, () => new GoldBot(level, random));
  }
  /** The mining clock now (between steps), ms after BAŞLA; negative in the countdown. */
  get now() {
    const g = this.game;
    return g.phase === "countdown" ? -(g.countdownTicks * 1000) / G.hz + this.acc * 1000 : g.elapsedMs + (g.phase === "mining" ? this.acc * 1000 : 0);
  }
  step() {
    const g = this.game,
      due = g.elapsedMs + 1000 / G.hz;
    const shots: (GoldShot | undefined)[] = [this.shot ?? undefined];
    this.shot = null;
    this.bots.forEach((bot, i) => {
      const lane = i + 1,
        at = g.phase === "mining" ? bot.step(g, lane, due) : null;
      shots[lane] = at === null ? undefined : { shot: g.lanes[lane].hook.shots + 1, at };
    });
    g.step(shots);
  }
  frame(dt: number, paused: boolean): GoldFrame {
    if (!paused) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.step();
      }
    }
    const wire = goldSection(this.game, this.game.lanes.map((_, lane) => lane));
    return { wire, now: this.game.phase === "results" ? wire.elapsed : this.now, winner: this.game.winner(), round: 1, self: 0, pending: null };
  }
  press() {
    const g = this.game,
      t = this.now;
    if (this.shot || !canFire(goldSection(g, g.lanes.map((_, lane) => lane)), 0, t)) return false;
    this.shot = { shot: g.lanes[0].hook.shots + 1, at: t };
    return true;
  }
}

/** A local mine for `players` (the player plus bots of `level`): its source, the miners and the HUD rows. */
export function localGoldMiner(players: 2 | 3, level: BotLevel, costume: SelectableCostumeId) {
  const source = new LocalGoldMiner(players, level);
  const looks: GoldLaneLook[] = source.game.lanes.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${BOT_LEVEL_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
    self: lane === 0,
  }));
  const first = goldSection(source.game, looks.map((_, lane) => lane));
  return { source, looks, first, hud: looks.map(({ name, color }) => ({ name, color, connected: true })) };
}
