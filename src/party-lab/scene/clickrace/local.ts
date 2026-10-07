import { CLICK_RACE as C } from "../../../../shared/party-lab/simulation/clickrace/config";
import { ClickRaceGame } from "../../../../shared/party-lab/simulation/clickrace/game";
import { clickSection } from "../../../../shared/party-lab/simulation/clickrace/wire";
import { BOT_NAMES, BOT_PACES, ClickBot } from "./bots";
import type { ClickFrame, ClickSource } from "./online";
import type { ClickLaneLook } from "./visual";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type SelectableCostumeId } from "../visual/costumes";

const STEP = 1 / C.hz;
/**
 * Yerel Test Arenası: the same rules as the server (ClickRaceGame, 25/s cap included) run
 * here, with the player in lane 0 and bots in the others. It pauses while the menu is open.
 */
export class LocalClickRace implements ClickSource {
  readonly game: ClickRaceGame;
  readonly bots: ClickBot[];
  private acc = 0;
  private pending: number[] = [];
  constructor(readonly lanes: number, random: () => number = Math.random) {
    this.game = new ClickRaceGame(lanes);
    this.bots = Array.from({ length: lanes - 1 }, (_, i) => new ClickBot(BOT_PACES[i % BOT_PACES.length], random));
  }
  /** The race clock now (between steps), ms after BAŞLA. */
  private get now() {
    return this.game.elapsedMs + this.acc * 1000;
  }
  step() {
    const g = this.game,
      due = g.phase === "racing" ? g.elapsedMs + 1000 / C.hz : -1;
    g.step([this.pending.splice(0), ...this.bots.map((bot) => (due >= 0 ? bot.presses(due) : []))]);
  }
  frame(dt: number, paused: boolean): ClickFrame {
    if (!paused) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.step();
      }
    }
    return { wire: clickSection(this.game, this.game.lanes.map((_, lane) => lane)), winner: this.game.winner(), round: 1 };
  }
  press() {
    const lane = this.game.lanes[0];
    if (this.game.phase !== "racing" || lane.finish !== null) return false;
    this.pending.push(this.now);
    return true;
  }
}

/** A fourth lane's colour (the room's three slots have their own). */
const EXTRA_COLOR = "#8fc98b";
/** A local race for `players` (the player plus bots): its source, the cars and the HUD rows. */
export function localClickRace(players: number, costume: SelectableCostumeId) {
  const source = new LocalClickRace(players);
  const color = (lane: number) => PLAYERS[lane]?.color ?? EXTRA_COLOR;
  const looks: ClickLaneLook[] = source.game.lanes.map((_, lane) => ({
    color: color(lane),
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : BOT_NAMES[source.bots[lane - 1].rate] ?? "Bot",
    self: lane === 0,
  }));
  return { source, looks, hud: looks.map(({ name, color }) => ({ name, color, connected: true })) };
}
