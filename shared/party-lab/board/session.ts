import { MixedRotation, type GameMode } from "../modes.js";
import { BOARD, EFFECT, effectSeconds, moveSeconds, type BoardSquare } from "./config.js";
import { dieFrom, isWinnerChoice, moveOrder, rollDice, type DiceKind, type Die, type WinnerChoice } from "./rules.js";
import { generateSquares } from "./squares.js";
import type { BoardEffect, BoardPhase, BoardRoll, BoardWire } from "./wire.js";

/** What a board match needs from its room. */
export interface BoardHost {
  /** Start a mini game of `mode` for these slots now (no lobby, no Ready); false if it could not. */
  startMini(mode: GameMode, slots: readonly number[]): boolean;
  /** Stop the running mini game now (its results were shown long enough, or it is abandoned). */
  endMini(): void;
  /** The slot's player is connected (a disconnected player's turn is played for them). */
  connected(slot: number): boolean;
}

export interface BoardOptions {
  length: number;
  slots: readonly number[];
  random?: () => number;
  die?: Die;
  /** Mini game order: random, no repeats within a cycle, fit for the player count. */
  rotation?: MixedRotation;
  /** Special squares; a fresh random layout (from `random`) when left out. */
  squares?: readonly BoardSquare[];
}

/**
 * One board match, server-authoritative. Phases: intro → minigame → for each player in
 * move order: (choose, the mini game winner only) → roll → move → (effect, when the move
 * ended exactly on a special square) → … → intro, until a player reaches the treasure
 * (finished). Driven by `step(dt)` at the room's tick rate;
 * no clocks, engines or sockets, so tests run it directly.
 */
export class BoardSession {
  readonly length: number;
  readonly squares: BoardSquare[];
  /** Slot → square, in slot order. */
  readonly pieces = new Map<number, number>();
  phase: BoardPhase = "intro";
  /** Board round (one mini game each), 1-based. */
  round = 1;
  /** Seconds spent in the current phase (or mini game stage). */
  phaseTime = 0;
  /** This round's move order and the index whose turn it is. */
  order: number[] = [];
  turn = -1;
  /** The last mini game's winner (−1: draw or none) and its mode. */
  first = -1;
  lastMode: GameMode | null = null;
  /** The mode the next (or running) mini game is played in. */
  mode: GameMode;
  choice: WinnerChoice | null = null;
  roll: BoardRoll | null = null;
  winner = -1;
  reason: "treasure" | "forfeit" | null = null;
  /** Slots holding a bonus die (+1 on their next roll; it does not stack). */
  readonly bonus = new Set<number>();
  /** The latest special square effect; `seq` grows with each, like rolls. */
  effect: BoardEffect | null = null;
  /** The celebration is over: the room returns to the lobby. */
  done = false;
  private mini: "playing" | "results" = "playing";
  private placements: readonly number[] | null = null;
  private moveFor = 0;
  private rollSeq = 0;
  private effectFor = 0;
  private effectSeq = 0;
  private readonly random: () => number;
  private readonly die: Die;
  readonly rotation: MixedRotation;

  constructor(private readonly host: BoardHost, options: BoardOptions) {
    const slots = [...new Set(options.slots)].sort((a, b) => a - b);
    if (slots.length < 2 || slots.length > BOARD.maxPlayers) throw new Error("BOARD_PLAYERS");
    this.length = options.length;
    this.random = options.random ?? Math.random;
    if (options.squares && options.squares.length !== options.length + 1) throw new Error("BOARD_SQUARES");
    this.squares = options.squares ? options.squares.map((s) => ({ ...s })) : generateSquares(options.length, this.random);
    this.die = options.die ?? dieFrom(this.random);
    this.rotation = options.rotation ?? new MixedRotation(this.random);
    for (const slot of slots) this.pieces.set(slot, 0);
    this.rotation.setPlayers(slots.length);
    this.mode = this.rotation.next;
  }

  get slots() {
    return [...this.pieces.keys()];
  }
  get current() {
    return this.phase === "choose" || this.phase === "roll" || this.phase === "move" || this.phase === "effect" ? this.order[this.turn] ?? -1 : -1;
  }
  has(slot: number) {
    return this.pieces.has(slot);
  }
  square(slot: number) {
    return this.pieces.get(slot) ?? 0;
  }
  /** Seconds left in a timed phase (0 when untimed). */
  get left() {
    const limit =
      this.phase === "intro" ? BOARD.introSeconds
      : this.phase === "choose" ? BOARD.chooseSeconds
      : this.phase === "roll" ? BOARD.rollSeconds
      : this.phase === "finished" ? BOARD.finishSeconds
      : this.phase === "minigame" && this.mini === "results" ? BOARD.miniResultsSeconds
      : 0;
    return limit ? Math.max(0, Math.ceil(limit - this.phaseTime - 1e-9)) : 0;
  }

  step(dt: number) {
    if (this.done) return;
    // Nobody at the table: the board waits (a running mini game keeps its own clock).
    if (this.phase !== "minigame" && this.phase !== "finished" && !this.slots.some((slot) => this.host.connected(slot))) return;
    this.phaseTime += dt;
    const away = () => !this.host.connected(this.current) && this.phaseTime + 1e-9 >= BOARD.awaySeconds;
    switch (this.phase) {
      case "intro":
        if (this.phaseTime + 1e-9 >= BOARD.introSeconds) this.startMini();
        break;
      case "minigame":
        if (this.mini === "results" && this.phaseTime + 1e-9 >= BOARD.miniResultsSeconds) {
          this.host.endMini();
          this.beginTurns();
        } else if (this.mini === "playing" && this.phaseTime + 1e-9 >= BOARD.miniTimeoutSeconds) {
          this.host.endMini();
          this.record(-1, null);
          this.beginTurns();
        }
        break;
      case "choose":
        if (away()) {
          // Away when the turn comes: "two dice", rolled at once.
          this.choice = "two";
          this.doRoll(true);
        } else if (this.phaseTime + 1e-9 >= BOARD.chooseSeconds) this.choose(this.current, "two");
        break;
      case "roll":
        if (away() || this.phaseTime + 1e-9 >= BOARD.rollSeconds) this.doRoll(true);
        break;
      case "move":
        if (this.phaseTime + 1e-9 >= this.moveFor) {
          const slot = this.roll!.slot;
          if (this.has(slot) && this.square(slot) >= this.length) this.finish(slot, "treasure");
          else if (!this.has(slot) || !this.applySquare(slot)) this.nextTurn(this.turn + 1);
        }
        break;
      case "effect":
        if (this.phaseTime + 1e-9 >= this.effectFor) {
          const slot = this.effect!.slot;
          if (this.has(slot) && this.square(slot) >= this.length) this.finish(slot, "treasure");
          else this.nextTurn(this.turn + 1);
        }
        break;
      case "finished":
        if (this.phaseTime + 1e-9 >= BOARD.finishSeconds) this.done = true;
        break;
    }
  }

  /** The running mini game reached its results (winner −1: draw or none). */
  miniResult(winner: number, placements: readonly number[] | null) {
    if (this.phase !== "minigame" || this.mini !== "playing") return;
    this.record(winner, placements);
    this.mini = "results";
    this.phaseTime = 0;
  }
  /** The mini game returned to waiting on its own (its results were shorter than the board's). */
  miniEnded() {
    if (this.phase !== "minigame") return;
    if (this.mini === "playing") this.record(-1, null);
    this.beginTurns();
  }

  /** The mini game winner's dice choice, at the start of their turn. */
  choose(slot: number, choice: unknown) {
    if (this.phase !== "choose" || slot !== this.current || !isWinnerChoice(choice)) return false;
    this.choice = choice;
    this.phase = "roll";
    this.phaseTime = 0;
    return true;
  }
  /** The current player pressed "Zar At". */
  rollPressed(slot: number) {
    if (this.phase !== "roll" || slot !== this.current) return false;
    this.doRoll(false);
    return true;
  }

  /** Left the room for good (Esc menu, or the seat grace ran out). */
  remove(slot: number) {
    if (!this.pieces.has(slot) || this.done) return;
    this.pieces.delete(slot);
    this.bonus.delete(slot);
    if (this.phase === "finished") return;
    const index = this.order.indexOf(slot);
    const wasCurrent = index >= 0 && index === this.turn && this.current === slot;
    if (index >= 0) {
      this.order.splice(index, 1);
      if (index < this.turn) this.turn--;
    }
    if (this.pieces.size < 2) {
      if (this.phase === "minigame") this.host.endMini();
      this.finish(this.slots[0] ?? -1, "forfeit");
      return;
    }
    this.rotation.setPlayers(this.pieces.size);
    if (this.phase === "intro") this.mode = this.rotation.next;
    if (wasCurrent) this.nextTurn(this.turn);
  }

  wire(): BoardWire {
    return {
      phase: this.phase,
      length: this.length,
      round: this.round,
      pieces: this.slots.map((slot) => [slot, this.square(slot)]),
      order: [...this.order],
      current: this.current,
      first: this.first,
      choice: this.choice,
      mode: this.mode,
      lastMode: this.lastMode,
      mini: this.phase === "minigame" ? this.mini : null,
      roll: this.roll ? { ...this.roll, dice: [...this.roll.dice] } : null,
      squares: this.squares.filter((s) => s.type !== "normal").map((s) => [s.index, s.type, s.target] as BoardWire["squares"][number]),
      bonus: this.slots.filter((slot) => this.bonus.has(slot)),
      effect: this.effect ? { ...this.effect } : null,
      left: this.left,
      winner: this.winner,
      reason: this.reason,
    };
  }

  private startMini() {
    const mode = this.rotation.next;
    this.rotation.played();
    this.mode = this.lastMode = mode;
    this.phase = "minigame";
    this.mini = "playing";
    this.phaseTime = 0;
    this.placements = null;
    // A mini game that cannot start is a round without a winner.
    if (!this.host.startMini(mode, this.slots)) this.miniEnded();
  }
  private record(winner: number, placements: readonly number[] | null) {
    this.first = this.has(winner) ? winner : -1;
    this.placements = placements;
  }
  private beginTurns() {
    this.order = moveOrder(this.slots, (slot) => this.square(slot), this.first, this.placements, this.random);
    this.nextTurn(0);
  }
  private nextTurn(index: number) {
    this.turn = index;
    this.choice = null;
    this.phaseTime = 0;
    if (index >= this.order.length) {
      this.round++;
      this.turn = -1;
      this.order = [];
      this.phase = "intro";
      this.mode = this.rotation.next;
      return;
    }
    this.phase = this.order[index] === this.first ? "choose" : "roll";
  }
  private doRoll(auto: boolean) {
    const slot = this.current;
    const kind: DiceKind = slot === this.first ? this.choice ?? "two" : "single";
    if (slot === this.first) this.choice = kind as WinnerChoice;
    const rolled = rollDice(kind, this.die);
    // A bonus die adds one to this roll (on top of "two dice" or "+1") and is used up.
    const bonus = this.bonus.delete(slot);
    const dice = rolled.dice,
      value = rolled.value + (bonus ? 1 : 0);
    const from = this.square(slot),
      to = Math.min(this.length, from + value);
    this.pieces.set(slot, to);
    this.roll = { seq: ++this.rollSeq, slot, kind, dice, value, bonus, from, to, auto };
    this.moveFor = moveSeconds(to - from);
    this.phase = "move";
    this.phaseTime = 0;
  }
  /**
   * The move ended exactly on `slot`'s square: a special square's effect, shown for
   * effectSeconds before the next turn. The square it sends a player to never acts.
   * False on a normal square.
   */
  private applySquare(slot: number) {
    const at = this.square(slot),
      square = this.squares[at];
    if (!square || square.type === "normal") return false;
    let to = at,
      other = -1,
      gained = false;
    switch (square.type) {
      case "forward":
        to = Math.min(this.length, at + EFFECT.forward);
        break;
      case "back":
        to = Math.max(0, at - EFFECT.back);
        break;
      case "ladder":
      case "slide":
        to = Math.max(0, Math.min(this.length, square.target));
        break;
      case "bonus":
        gained = !this.bonus.has(slot);
        this.bonus.add(slot);
        break;
      case "swap": {
        // A random player on another square; nobody there (all on this square): nothing happens.
        const others = this.slots.filter((s) => s !== slot && this.square(s) !== at);
        if (others.length) {
          other = others[Math.min(others.length - 1, Math.floor(this.random() * others.length))];
          to = this.square(other);
          this.pieces.set(other, at);
        }
        break;
      }
    }
    this.pieces.set(slot, to);
    this.effect = { seq: ++this.effectSeq, slot, type: square.type, from: at, to, other, gained };
    this.effectFor = effectSeconds(this.effect);
    this.phase = "effect";
    this.phaseTime = 0;
    return true;
  }
  private finish(winner: number, reason: "treasure" | "forfeit") {
    this.winner = winner;
    this.reason = reason;
    this.phase = "finished";
    this.phaseTime = 0;
    this.turn = -1;
  }
}
