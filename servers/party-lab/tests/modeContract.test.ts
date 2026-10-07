/**
 * What every online mode owes the lobby, Mixed and Tahta Oyunu. It loops over GAME_MODES,
 * so a new mode is checked the moment it is added there: a name, an arena, a player count
 * its simulation honours, a place in both rotations, a place in the Yerel Test Arenası,
 * and a winner plus placements() at results (the board orders its moves by them).
 */
import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { createSimulation } from "../src/PartyRoom.js";
import { MAX_PLAYERS } from "../src/validation.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { GAME_MODES, MODE_MAP, MODE_NAMES, MODE_PLAYERS, MODE_SELECTIONS, MixedRotation, modeFits, type GameMode } from "../../../shared/party-lab/modes.js";
import { NET } from "../../../shared/party-lab/network/protocol.js";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online.js";
import { IDLE_INPUT, initializePhysics } from "../../../shared/party-lab/simulation/physics.js";
import { PLAYERS, type PlayerId } from "../../../shared/party-lab/simulation/players.js";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound.js";
import { PropRoundSimulation } from "../../../shared/party-lab/simulation/propRound.js";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character.js";

const DT = 1 / NET.physicsHz;
const IDLE = PLAYERS.map(() => IDLE_INPUT);
/**
 * Modes whose round keeps the scores when a player leaves: the one who stays still has to
 * out-score the frozen total, so a stayer who does nothing may draw. Every other mode must
 * hand the round to the last player left. A new mode joins this list only on purpose.
 */
const SCORE_KEPT_ON_FORFEIT: readonly GameMode[] = ["human_bowling", "snowball_fight", "kart_race", "classic_bowling"];

/** The highest `count` slots (2 players → slots 1 and 2), so a seat index is never mistaken for a slot. */
const slotsOf = (count: number) => PLAYERS.slice(PLAYERS.length - count).map((p) => p.id as PlayerId);
function seeded(seed: number) {
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}
before(() => initializePhysics());

test("every mode is a lobby choice with a name, an arena, a player count and its own simulation", () => {
  for (const mode of GAME_MODES) {
    assert.ok(MODE_SELECTIONS.includes(mode), `${mode}: not in MODE_SELECTIONS`);
    assert.ok(MODE_NAMES[mode], `${mode}: no MODE_NAMES entry`);
    assert.ok(MODE_MAP[mode], `${mode}: no MODE_MAP entry`);
    const players = MODE_PLAYERS[mode];
    assert.ok(players && players.min >= 2 && players.min <= players.max && players.max <= MAX_PLAYERS, `${mode}: MODE_PLAYERS must be 2 ≤ min ≤ max ≤ ${MAX_PLAYERS}`);
    for (let count = 1; count <= MAX_PLAYERS; count++) {
      const sim = createSimulation(mode, newRoomCounters());
      try {
        assert.equal(sim.mode, mode, `${mode}: createSimulation (PartyRoom.ts) builds another mode's simulation`);
        assert.equal(sim.start(slotsOf(count)), modeFits(mode, count), `${mode}: start() with ${count} players disagrees with MODE_PLAYERS`);
      } finally {
        sim.dispose();
      }
    }
  }
});

test("every mode is playable in the Yerel Test Arenası (with bots)", () => {
  for (const mode of GAME_MODES)
    assert.ok(LOCAL_ARENA_IDS.includes(MODE_MAP[mode] as never), `${mode}: "${MODE_MAP[mode]}" is not in the local arena list (shared/party-lab/localArenas.ts LOCAL_MODE_ARENAS) — add it there and give it a local playground with bots in ArenaScene.tsx`);
});

test("Mixed and the board's mini games include every mode that fits the player count", () => {
  for (let count = 2; count <= MAX_PLAYERS; count++) {
    const fits = GAME_MODES.filter((mode) => modeFits(mode, count)).sort();
    assert.ok(fits.length >= 2, `${count} players: Mixed needs two modes to avoid repeats`);
    // Mixed: one cycle plays every fitting mode once.
    const mixed = new MixedRotation(seeded(count));
    mixed.setPlayers(count);
    const played = fits.map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.deepEqual(played.sort(), fits, `Mixed, ${count} players`);
    // Tahta Oyunu: one mini game per board round; the first rounds cover the same modes.
    const minis: GameMode[] = [];
    const host: BoardHost = { startMini: (mode) => (minis.push(mode), true), endMini() {}, connected: () => true };
    const board = new BoardSession(host, { length: 50, slots: slotsOf(count), random: seeded(count), die: () => 1, squares: boardSquares(50) });
    const until = (done: () => boolean, act = () => board.step(DT)) => {
      for (let t = 0; t < 600 / DT && !done(); t++) act();
      assert.ok(done(), `board stuck in ${board.phase}`);
    };
    while (minis.length < fits.length) {
      until(() => board.phase === "minigame");
      board.miniResult(-1, null);
      until(() => board.phase !== "minigame");
      until(() => board.phase === "intro", () => (board.phase === "roll" ? board.rollPressed(board.current) : board.step(DT)));
    }
    assert.deepEqual(minis.sort(), fits, `Tahta Oyunu, ${count} players`);
  }
});

test("every mode reports its winner and placements(): everyone else leaves, the last player stays", () => {
  for (const mode of GAME_MODES) {
    // Wall-clock timeouts (an idle Classic Bowling turn) run on the simulation's clock.
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const sim = createSimulation(mode, newRoomCounters());
    try {
      assert.equal(typeof sim.placements, "function", `${mode}: no placements(); the board needs them to order moves`);
      const slots = slotsOf(MODE_PLAYERS[mode].min),
        [stayer, ...leavers] = slots;
      const step = () => {
        sim.step(IDLE);
        mock.timers.tick(1000 * DT);
      };
      // Read through a call: an assertion on `sim.phase` would narrow its type for the next one.
      const phase = () => sim.phase;
      assert.ok(sim.start(slots), `${mode}: start(${slots})`);
      for (let t = 0; t < 60 / DT && phase() !== "playing"; t++) step();
      assert.equal(phase(), "playing", `${mode}: never reached play`);
      for (const slot of leavers) sim.remove(slot);
      for (let t = 0; t < 900 / DT && phase() !== "results"; t++) step();
      assert.equal(phase(), "results", `${mode}: the round never ends with one idle player left`);

      const winner = sim.winner,
        places = sim.placements!();
      if (SCORE_KEPT_ON_FORFEIT.includes(mode)) assert.ok(winner === stayer || winner === -1, `${mode}: winner ${winner}`);
      else assert.equal(winner, stayer, `${mode}: the last player left must win (winner is a slot, −1 only for a draw)`);
      assert.ok(places, `${mode}: placements() is null at results`);
      assert.equal(places.length, PLAYERS.length, `${mode}: placements are per slot`);
      for (const { id } of PLAYERS)
        if (slots.includes(id)) assert.ok(Number.isInteger(places[id]) && places[id] >= 0, `${mode}: slot ${id} played but has no place`);
        else assert.equal(places[id], -1, `${mode}: slot ${id} did not play`);
      assert.equal(places[stayer], 0, `${mode}: the player who stayed is ranked below one who left`);
      assert.equal(sim.snapshot(PLAYERS.map(() => 0)).winner, winner, `${mode}: the snapshot's winner differs`);
    } finally {
      sim.dispose();
      mock.timers.reset();
    }
  }
});

test("Çatı Kavgası placements follow the falls; Saklambaç ranks the winning side first", () => {
  const roof = new OnlineRoundSimulation();
  try {
    assert.ok(roof.start([0, 1, 2]));
    for (let t = 0; t < 4 / DT && roof.phase !== "playing"; t++) roof.step(IDLE);
    restore(roof.physics.players[2], { x: 0, y: -6, z: 0 }, 0);
    for (let t = 0; t < 10; t++) roof.step(IDLE);
    restore(roof.physics.players[0], { x: 2, y: -6, z: 0 }, 0);
    for (let t = 0; t < 2 / DT && roof.phase !== "results"; t++) roof.step(IDLE);
    assert.equal(roof.winner, 1);
    assert.deepEqual(roof.placements(), [1, 0, 2], "standing, then the later fall, then the first");
  } finally {
    roof.dispose();
  }
  // The seeker (slot 0) leaves: the hiders win together, the seeker is last.
  const prop = new PropRoundSimulation();
  try {
    assert.ok(prop.start([0, 1, 2]));
    for (let t = 0; t < 60 / DT && prop.phase !== "playing"; t++) prop.step(IDLE);
    prop.remove(0);
    assert.equal(prop.phase, "results");
    assert.equal(prop.winner, -1);
    assert.deepEqual(prop.placements(), [2, 0, 0]);
  } finally {
    prop.dispose();
  }
});
