/**
 * Hediye Kapmaca: the round yard (symmetric for 2 and 3), taking (pile, floor, a rival's home;
 * never your own), one box at a time, putting it down at home, the punch on a carrier (the box
 * flies, the carrier is stunned, then guarded), stagger guards, where a knocked box lands, two
 * reaching for one box, the 40 s clock, places, bots, the wire, the round simulation and a room.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { GIFT, GIFT_TICKS, pileSize } from "../../../shared/party-lab/simulation/gifts/config.js";
import { GiftGame } from "../../../shared/party-lab/simulation/gifts/game.js";
import { GiftBot, steer } from "../../../shared/party-lab/simulation/gifts/bots.js";
import { decodeGiftWire, giftFlags, giftWire, validGiftWire } from "../../../shared/party-lab/simulation/gifts/wire.js";
import { reachAt } from "../../../shared/party-lab/simulation/gifts/reach.js";
import { GiftRoundSimulation } from "../../../shared/party-lab/simulation/giftRound.js";
import { GIFT_DECOR, GIFT_MAP, GIFT_SOLIDS, giftSpawn, homeAngle, homeCenter, restingPoint } from "../../../shared/party-lab/maps/gifts.js";
import { InputMailbox, NET, validateGiftInput, type GameSnapshot, type GiftInputPacket } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { IDLE_INPUT, initializePhysics } from "../../../shared/party-lab/simulation/physics.js";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character.js";
import { PLAYERS, type PlayerId } from "../../../shared/party-lab/simulation/players.js";
import type { MovementInput } from "../../../shared/party-lab/intent.js";

before(() => initializePhysics());
const IDLE = PLAYERS.map(() => IDLE_INPUT);
const facing = (dx: number, dz: number) => Math.atan2(dx, dz);
/** A game already playing (the countdown run through). */
function playing(players: 2 | 3 = 3, seed = 1) {
  const game = new GiftGame(undefined, { players, seed });
  while (game.round.phase === "countdown") game.step(IDLE);
  return game;
}
function put(game: GiftGame, slot: PlayerId, x: number, z: number, yaw = 0) {
  restore(game.physics.players[slot], { x, y: 0.9, z }, yaw);
}
/** Steps with `who` doing `input` (everyone else still), stopping early when `stop` says so. */
function run(game: GiftGame, ticks: number, inputs: Partial<Record<PlayerId, MovementInput>> = {}, stop: () => boolean = () => false) {
  for (let i = 0; i < ticks && !stop(); i++) game.step(PLAYERS.map(({ id }) => inputs[id] ?? IDLE_INPUT));
}
const press = (extra: Partial<MovementInput> = {}): MovementInput => ({ x: 0, z: 0, jump: false, ...extra });
const pelvis = (game: GiftGame, slot: PlayerId) => game.physics.players[slot].body.translation();
/** Everyone out of the way, far apart on the yard's middle ring between homes. */
function park(game: GiftGame, except: PlayerId[] = []) {
  for (const { id } of PLAYERS) if (!except.includes(id) && game.seatOf[id] >= 0) put(game, id, Math.sin(2.1 + id * 2.1) * 4, Math.cos(2.1 + id * 2.1) * 4);
}

test("the yard: one round map for 2 and 3 players; homes 6.8 m out, 120° / 180° apart; every solid turns onto itself by 60°, so the yard is exactly symmetric for both", () => {
  for (const players of [2, 3]) {
    const homes = Array.from({ length: players }, (_, seat) => homeCenter(players, seat));
    for (const [seat, h] of homes.entries()) {
      assert.ok(Math.abs(Math.hypot(h.x, h.z) - GIFT.homes.distance) < 1e-9, "the same distance from the middle");
      const next = homes[(seat + 1) % players],
        turn = (2 * Math.PI) / players,
        // Turning a home by 360°/n about the middle gives the next one, and the same for spawns.
        tx = h.x * Math.cos(turn) + h.z * Math.sin(turn),
        tz = -h.x * Math.sin(turn) + h.z * Math.cos(turn);
      assert.ok(Math.hypot(tx - next.x, tz - next.z) < 1e-9, `${players}P: home ${seat} turned is home ${(seat + 1) % players}`);
      const s = giftSpawn(players, seat);
      assert.ok(Math.hypot(s.x - h.x, s.z - h.z) < 1e-9, "everyone starts in their home");
    }
    assert.equal(Math.round(((homeAngle(players, 1) - homeAngle(players, 0)) * 180) / Math.PI), players === 3 ? 120 : 180);
  }
  // Every solid, turned 60° about the middle, lands on a solid of the same kind (the wall, the stand, the trees).
  const key = (c: (typeof GIFT_MAP.colliders)[number], turn = 0) => {
    const x = c.center.x * Math.cos(turn) + c.center.z * Math.sin(turn),
      z = -c.center.x * Math.sin(turn) + c.center.z * Math.cos(turn),
      size = c.shape === "cylinder" ? `${c.radius}:${c.halfHeight}` : c.shape === "box" ? `${c.half.x}:${c.half.y}:${c.half.z}` : "ramp";
    const mm = (v: number) => Math.round(v * 1000) || 0;
    return `${c.role}:${c.shape}:${size}:${mm(x)}:${mm(c.center.y)}:${mm(z)}`;
  };
  const solids = GIFT_MAP.colliders.filter((c) => c.role !== "floor"),
    keys = new Set(solids.map((c) => key(c)));
  for (const c of solids) assert.ok(keys.has(key(c, Math.PI / 3)), `${c.role} at ${c.center.x.toFixed(2)},${c.center.z.toFixed(2)} turned by 60°`);
  assert.equal(solids.filter((c) => c.role === "parapet").length, GIFT.arena.wall.segments);
  assert.equal(GIFT.arena.wall.segments % 6, 0);
  // The wall leaves no gap: each segment is longer than its share of the circle.
  const wall = solids.find((c) => c.role === "parapet")!;
  assert.ok(wall.shape === "box" && 2 * wall.half.x > 2 * Math.PI * (GIFT.arena.radius + GIFT.arena.wall.thickness) / GIFT.arena.wall.segments);
  // The stand cannot be climbed (≥ 1.5 m is never crossed); the trees stand between the homes, off every path.
  assert.ok(GIFT.pedestal.height >= 1.5 && GIFT.decor.height >= 1.5);
  for (const players of [2, 3])
    for (const p of GIFT_DECOR) {
      const nearest = Math.min(...Array.from({ length: players }, (_, seat) => Math.abs(Math.atan2(Math.sin(Math.atan2(p.x, p.z) - homeAngle(players, seat)), Math.cos(Math.atan2(p.x, p.z) - homeAngle(players, seat))))));
      assert.ok(nearest >= Math.PI / 6 - 1e-9, "30° or more off every home's line to the middle");
      for (let seat = 0; seat < players; seat++) {
        // Clear of the straight walk from a home to the middle (the pile run).
        const h = homeCenter(players, seat),
          along = Math.max(0, Math.min(1, (p.x * h.x + p.z * h.z) / (h.x * h.x + h.z * h.z)));
        assert.ok(Math.hypot(p.x - h.x * along, p.z - h.z * along) - GIFT.decor.radius > 2, "the home-to-pile run passes far from it");
      }
    }
  assert.equal(pileSize(3), 13);
  assert.equal(pileSize(2), 9);
});

test("taking: Tut takes one box from the pile; only one carried at a time (a second press does nothing); a carrier entering its own home puts it down at once", () => {
  const game = playing(3);
  park(game, [0]);
  put(game, 0, 0, GIFT.pedestal.radius + 0.5, facing(0, -1));
  run(game, 10);
  assert.equal(game.pile, 13);
  run(game, 1, { 0: press({ pickup: true }) });
  assert.ok(game.carrying[0], "took one");
  assert.equal(game.pile, 12);
  assert.equal(game.events[0]?.kind, "pile");
  run(game, 5);
  run(game, 1, { 0: press({ pickup: true }) });
  run(game, 12);
  assert.equal(game.pile, 12, "a second press while carrying takes nothing");
  assert.ok(game.carrying[0]);
  assert.equal(game.total(), 13);
  // Home: the moment it is inside its circle, the box is down there.
  const home = game.homeOf(0);
  put(game, 0, home.x, home.z);
  run(game, 1);
  assert.ok(!game.carrying[0]);
  assert.equal(game.home[0], 1);
  assert.equal(game.events.find((e) => e.kind === "deposit")?.actor, 0);
  assert.equal(game.total(), 13);
  // Nothing in reach: a press does nothing and is forgotten after its 0.15 s.
  put(game, 0, home.x * 0.6, home.z * 0.6);
  run(game, 1, { 0: press({ pickup: true }) });
  run(game, GIFT_TICKS.pressBuffer + 2);
  assert.equal(game.want[0], 0);
  assert.ok(!game.carrying[0]);
  game.dispose();
});

test("a press waits 0.15 s: pressing just before reaching the pile still takes one", () => {
  const game = playing(3);
  park(game, [0]);
  put(game, 0, 0, 4, facing(0, -1));
  run(game, 8);
  // Walking in: press once about 0.3 m short of the reach, then keep walking.
  const outside = () => pelvis(game, 0).z - GIFT.pedestal.radius - GIFT.reach.pile;
  run(game, 120, { 0: press({ z: -1 }) }, () => outside() <= 0.3);
  assert.ok(outside() > 0, "still out of reach when pressing");
  run(game, 1, { 0: press({ z: -1, pickup: true }) });
  assert.ok(!game.carrying[0]);
  run(game, GIFT_TICKS.pressBuffer, { 0: press({ z: -1 }) }, () => game.carrying[0]);
  assert.ok(game.carrying[0], "the waiting press took one on arrival");
  game.dispose();
});

test("homes: your own is never taken from; a rival's gives one box per press, only while you stand inside it", () => {
  const game = playing(3);
  park(game);
  game.pile = 0;
  game.home[0] = 3;
  const home = game.homeOf(0);
  put(game, 0, home.x, home.z);
  run(game, 3);
  run(game, 1, { 0: press({ pickup: true }) });
  run(game, GIFT_TICKS.pressBuffer + 1);
  assert.ok(!game.carrying[0], "not from your own home");
  assert.equal(game.home[0], 3);
  // Slot 2 just outside the circle: nothing.
  const out = (GIFT.homes.radius + 0.35) / GIFT.homes.distance;
  put(game, 2, home.x * (1 - out), home.z * (1 - out));
  run(game, 2);
  run(game, 1, { 2: press({ pickup: true }) });
  run(game, GIFT_TICKS.pressBuffer + 1);
  assert.ok(!game.carrying[2]);
  // Slot 1 inside it: one box, the owner told.
  put(game, 1, home.x * 0.88, home.z * 0.88);
  run(game, 2);
  run(game, 1, { 1: press({ pickup: true }) });
  assert.ok(game.carrying[1]);
  assert.equal(game.home[0], 2);
  const steal = game.events.find((e) => e.kind === "steal")!;
  assert.deepEqual([steal.actor, steal.owner], [1, 0]);
  assert.equal(game.total(), 3);
  game.dispose();
});

/** Two players 1.0 m apart east–west in the open (south of the stand), `a` facing `b`. */
function faceOff(game: GiftGame, a: PlayerId, b: PlayerId) {
  park(game, [a, b]);
  put(game, a, -0.5, 3.4, facing(1, 0));
  put(game, b, 0.5, 3.4, facing(-1, 0));
  run(game, 20);
}

test("the punch on a carrier: a carrier cannot punch; a punch knocks the box 1.5–2.5 m away (it lands, then anyone may take it) and stuns 1 s (no walking, punching or taking); then 1.5 s guarded", () => {
  const game = playing(3, 5);
  faceOff(game, 0, 1);
  game.pile = 12;
  game.carrying[1] = true;
  // The carrier presses Yumruk: no swing at all.
  run(game, 1, { 1: press({ punch: true }) });
  assert.equal(game.brawl.fighters[1].punch.age, -1, "a carrier never punches");
  // Slot 0 punches: the box flies along the hit and the carrier is stunned.
  const victim = { ...pelvis(game, 1) };
  run(game, 1, { 0: press({ punch: true }) });
  run(game, 25, {}, () => !game.carrying[1]);
  assert.ok(!game.carrying[1], "knocked off");
  const knock = game.log.find((e) => e.kind === "knock")!;
  assert.deepEqual([knock.actor, knock.owner], [1, 0]);
  assert.equal(game.boxes.length, 1);
  const box = game.boxes[0],
    flew = Math.hypot(box.x - victim.x, box.z - victim.z);
  assert.ok(flew >= GIFT.drop.distance[0] - 0.35 && flew <= GIFT.drop.distance[1] + 0.35, `flew ${flew.toFixed(2)} m`);
  assert.ok(box.x > victim.x, "along the hit (away from the puncher)");
  assert.equal(box.land - box.at, GIFT_TICKS.flight);
  assert.ok(game.stun[1] > GIFT_TICKS.stun - 3, "stunned");
  // In the air nobody can take it.
  put(game, 2, box.x, box.z + 0.4);
  run(game, 1, { 2: press({ pickup: true }) });
  assert.equal(game.boxes.length, 1);
  // Stunned: no walking (once the shove has died away the body stays), no punch, no taking.
  run(game, 12);
  const still = { ...pelvis(game, 1) };
  run(game, 20, { 1: press({ x: 1, punch: true, pickup: true }) });
  assert.equal(game.brawl.fighters[1].punch.age, -1);
  assert.ok(Math.hypot(pelvis(game, 1).x - still.x, pelvis(game, 1).z - still.z) < 0.3, "a stunned body does not walk away");
  // Landed: the first to press takes it (slot 2 stands right by it).
  run(game, GIFT_TICKS.flight, {}, () => game.boxes[0]?.land <= game.round.tick);
  run(game, 1, { 2: press({ pickup: true }) });
  assert.ok(game.carrying[2], "a landed box is anyone's");
  assert.equal(game.boxes.length, 0);
  // The stun ends after 1 s; then 1.5 s of guard.
  run(game, GIFT_TICKS.stun, {}, () => game.stun[1] === 0);
  assert.equal(game.stun[1], 0);
  assert.ok(game.guard[1] >= GIFT_TICKS.stunGuard - 1);
  // Guarded: a punch does nothing to a carrier.
  faceOff(game, 0, 1);
  game.carrying[1] = true;
  assert.ok(game.guard[1] > 0);
  for (let i = 0; i < 200 && game.guard[1] > 1; i++) run(game, 1, { 0: press({ punch: true }) });
  assert.ok(game.carrying[1], "a guarded carrier keeps the box");
  assert.equal(game.guard[1], 1);
  // Guard over: the next punch knocks it off again.
  run(game, 40, { 0: press({ punch: true }) }, () => !game.carrying[1]);
  assert.ok(!game.carrying[1]);
  game.dispose();
});

test("stagger chains: an ordinary landed punch shoves and staggers 0.35 s, then 0.6 s of guard in which no punch touches the target (no shove, no stagger)", () => {
  const game = playing(3, 9);
  faceOff(game, 0, 1);
  let landed = false;
  run(game, 120, { 0: press({ x: 0.25, punch: true }) }, () => (landed = game.brawl.shoves.some((s) => s.attacker === 0 && s.target === 1)));
  assert.ok(landed, "a real hand contact landed");
  assert.ok(game.brawl.fighters[1].stagger.time > 0.3);
  assert.ok(!game.carrying[1]);
  run(game, 40, {}, () => game.guard[1] > 0);
  assert.ok(game.guard[1] >= GIFT_TICKS.staggerGuard - 2, "guarded once the stagger ends");
  // While guarded, punches from right next to it never land.
  faceOff(game, 0, 1);
  if (game.guard[1] === 0) game.guard[1] = GIFT_TICKS.staggerGuard;
  let shoves = 0;
  // (The tick the guard reaches 0 a punch may land again.)
  while (game.guard[1] > 1) {
    run(game, 1, { 0: press({ x: 0.25, punch: true }) });
    shoves += game.brawl.shoves.filter((s) => s.target === 1).length;
  }
  assert.equal(shoves, 0);
  game.dispose();
});

test("where a knocked box lands: in a home it counts there at once (whoever's home); outside it lies on the floor; never in the wall, the stand or a tree", () => {
  const game = playing(3, 3);
  park(game, [0, 1]);
  // Slot 1 carrying, just outside slot 2's home, punched toward it: the box lands inside.
  const h2 = game.homeOf(2),
    toward = { x: -h2.x / GIFT.homes.distance, z: -h2.z / GIFT.homes.distance },
    at = { x: h2.x + toward.x * (GIFT.homes.radius + 1.0), z: h2.z + toward.z * (GIFT.homes.radius + 1.0) };
  put(game, 1, at.x, at.z, facing(-toward.x, -toward.z));
  put(game, 0, at.x + toward.x * 1.0, at.z + toward.z * 1.0, facing(-toward.x, -toward.z));
  run(game, 15);
  game.carrying[1] = true;
  run(game, 1, { 0: press({ punch: true }) });
  run(game, 25, {}, () => !game.carrying[1]);
  assert.ok(!game.carrying[1]);
  const box = game.boxes[0];
  const inside = Math.hypot(box.x - h2.x, box.z - h2.z) <= GIFT.homes.radius;
  run(game, GIFT_TICKS.flight + 1);
  if (inside) {
    assert.equal(game.home[2], 1, "landed in slot 2's home: slot 2's");
    assert.equal(game.boxes.length, 0);
    assert.equal(game.log.at(-1)?.kind, "home");
  } else assert.equal(game.boxes.length, 1);
  assert.ok(inside, `landed ${Math.hypot(box.x - h2.x, box.z - h2.z).toFixed(2)} m from the home's middle`);
  // Outside every home: it stays on the floor and belongs to nobody.
  const floor = restingPoint(0, 3.4);
  assert.ok(game.seats.every((id) => Math.hypot(floor.x - game.homeOf(id).x, floor.z - game.homeOf(id).z) > GIFT.homes.radius));
  // Resting points stay off the solids and inside the wall.
  for (const [x, z] of [[0, 0], [0.3, 0.2], [12, 0], [0, -11], ...GIFT_DECOR.map((p) => [p.x, p.z])]) {
    const p = restingPoint(x, z);
    assert.ok(Math.hypot(p.x, p.z) <= GIFT.arena.radius - GIFT.box.size / 2, "inside the wall");
    for (const s of GIFT_SOLIDS) assert.ok(Math.hypot(p.x - s.x, p.z - s.z) >= s.r + GIFT.box.size / 2 - 1e-9, "off the stand and the trees");
  }
  game.dispose();
});

test("two reaching for one thing on the same tick: the nearer takes it, the lower slot on an exact tie; the other's press keeps waiting", () => {
  const game = playing(3, 2);
  park(game);
  game.boxes.push({ id: 900, x: 0, z: 3.5, fx: 0, fy: 1, fz: 3.5, at: 0, land: 0 });
  put(game, 0, -0.8, 3.5);
  put(game, 2, 0.6, 3.5);
  run(game, 1, { 0: press({ pickup: true }), 2: press({ pickup: true }) });
  assert.ok(game.carrying[2] && !game.carrying[0], "slot 2 was nearer");
  assert.ok(game.want[0] > 0, "slot 0's press still waits");
  // An exact tie (mirror places): the lower slot.
  const tie = playing(3, 2);
  park(tie);
  tie.boxes.push({ id: 901, x: 0, z: 3.5, fx: 0, fy: 1, fz: 3.5, at: 0, land: 0 });
  // Called directly on positions the rule sees: equal distances, slot order decides.
  const reach1 = reachAt({ x: -0.7, z: 3.5 }, 1, tie, tie.round.tick),
    reach2 = reachAt({ x: 0.7, z: 3.5 }, 2, tie, tie.round.tick);
  assert.equal(reach1?.distance, reach2?.distance);
  put(tie, 1, -0.7, 3.5);
  put(tie, 2, 0.7, 3.5);
  // Bodies drift a little in a step: pin what each one reaches to the mirrored distances.
  tie.want[1] = tie.want[2] = GIFT_TICKS.pressBuffer;
  const original = tie.reachOf.bind(tie);
  tie.reachOf = (id) => (id === 1 ? reach1 : id === 2 ? reach2 : original(id));
  run(tie, 1);
  assert.ok(tie.carrying[1] && !tie.carrying[2], "the lower slot on a tie");
  // The pile's last box: one of two gets it.
  const last = playing(3, 4);
  park(last);
  last.pile = 1;
  put(last, 0, 0, GIFT.pedestal.radius + 0.45);
  put(last, 1, 0, -(GIFT.pedestal.radius + 0.6));
  run(last, 2);
  run(last, 1, { 0: press({ pickup: true }), 1: press({ pickup: true }) });
  assert.equal(last.pile, 0);
  assert.deepEqual([last.carrying[0], last.carrying[1]], [true, false], "the nearer took the last one");
  assert.equal(last.pileEmptyAt, last.round.tick - 1);
  game.dispose();
  tie.dispose();
  last.dispose();
});

test("the clock: play lasts exactly 40 s; only boxes at home count (not the one carried); most at home wins, a tie for most is a draw; places share on ties, a leaver is last", () => {
  const game = playing(3);
  park(game);
  game.pile = 0;
  game.home[0] = 4;
  game.home[1] = 3;
  game.home[2] = 3;
  game.carrying[1] = game.carrying[2] = true;
  let ticks = 0;
  while (game.round.phase === "playing") {
    game.step(IDLE);
    ticks++;
  }
  assert.equal(ticks, GIFT_TICKS.cap);
  assert.equal(game.round.reason, "timeout");
  assert.equal(game.round.winner, 0, "4 at home beats 3 + 1 carried");
  assert.deepEqual(game.placements(), [0, 1, 1]);
  // A tie for most: a draw.
  const tie = playing(2);
  park(tie);
  tie.home[0] = 2;
  tie.home[1] = 2;
  tie.carrying[0] = true;
  while (tie.round.phase === "playing") tie.step(IDLE);
  assert.equal(tie.round.winner, null);
  assert.deepEqual(tie.placements(), [0, 0, -1]);
  // A leaver (even with the most at home) is last and cannot win; one left alone wins at once.
  const three = playing(3);
  three.home[0] = 9;
  three.home[1] = 1;
  three.forfeit(0);
  run(three, 2);
  assert.equal(three.round.phase, "playing");
  three.round.tick = GIFT_TICKS.cap - 2;
  run(three, 3);
  assert.equal(three.round.winner, 1);
  assert.deepEqual(three.placements(), [2, 0, 1]);
  const two = playing(2);
  two.home[0] = 5;
  two.forfeit(0);
  run(two, 1);
  assert.equal(two.round.phase, "results");
  assert.equal(two.round.winner, 1);
  for (const g of [game, tie, three, two]) g.dispose();
});

test("bots: they clear the pile, steal once it is gone, knock carriers' boxes off; boxes are never made or lost; Zor beats Kolay", () => {
  const sum = { easy: 0, hard: 0 };
  for (let run = 0; run < 6; run++) {
    const game = new GiftGame(undefined, { players: 2, seed: 40 + run }),
      levels = run % 2 ? (["easy", "hard"] as const) : (["hard", "easy"] as const),
      bots = game.seats.map((slot, i) => new GiftBot(slot, levels[i], 11 + run));
    bots.forEach((b) => b.reset());
    const total = game.total();
    while (game.round.phase !== "results") {
      const inputs = PLAYERS.map(() => IDLE_INPUT);
      for (const b of bots) inputs[b.slot] = b.update(game);
      game.step(inputs);
      assert.equal(game.total(), total, "every box accounted for");
    }
    assert.ok(game.pileEmptyAt >= 0 && game.pileEmptyAt < 25 * 60, `pile gone at ${game.pileEmptyAt / 60} s`);
    assert.ok(game.stats.steals > 0, "they steal");
    game.seats.forEach((slot, i) => (sum[levels[i]] += game.home[slot]));
    game.dispose();
  }
  assert.ok(sum.hard > sum.easy, `Zor ${sum.hard} vs Kolay ${sum.easy}`);
  // Steering goes round the stand, never through it.
  const d = steer(0, -5, 0, 5);
  assert.ok(Math.abs(d.x) > 0.3, "turned off the straight line through the stand");
});

test("the wire: complete state survives encoding (boxes, homes, carriers, stun/guard, events); a malformed section is refused", () => {
  const game = playing(3);
  game.home[1] = 2;
  game.carrying[2] = true;
  game.boxes.push({ id: 7, x: 1.234, z: -2.5, fx: 0.5, fy: 1.9, fz: -1, at: 10, land: 40 });
  game.stun[0] = 30;
  game.guard[1] = 12;
  const wire = giftWire(game, giftFlags(game), 0);
  assert.ok(validGiftWire(wire));
  const d = decodeGiftWire(structuredClone(wire))!;
  assert.deepEqual(d.seats, [0, 1, 2]);
  assert.equal(d.pile, 13);
  assert.deepEqual(d.home, [0, 2, 0]);
  assert.deepEqual(d.carrying, [false, false, true]);
  assert.deepEqual(d.boxes[0], { id: 7, x: 1.23, z: -2.5, fx: 0.5, fy: 1.9, fz: -1, at: 10, land: 40 });
  assert.equal(d.stunUntil[0], wire.t + 30);
  assert.equal(d.guardUntil[1], wire.t + 12);
  for (const broken of [{ ...wire, c: 9 }, { ...wire, s: [0] }, { ...wire, b: [1, 2, 3] }, { ...wire, e: [0, 0, 99, 0, 0, 0, 0, 0] }, { ...wire, h: [0, 0] }, null])
    assert.equal(decodeGiftWire(broken), null);
  game.dispose();
});

test("the packet and mailbox: strict keys; jump, punch and Tut are edges kept until a step reads them; the punch carries its view tick", () => {
  const packet = (seq: number, extra: Partial<GiftInputPacket> = {}): GiftInputPacket => ({ seq, round: 1, moveX: 0.6, moveZ: 0.8, jumpPressed: false, sprintHeld: false, punchPressed: false, viewTick: 100, pickupPressed: false, ...extra });
  assert.deepEqual(validateGiftInput(packet(1)), packet(1));
  assert.equal(validateGiftInput({ ...packet(1), extra: 1 }), null);
  assert.equal(validateGiftInput({ ...packet(1), pickupPressed: 1 }), null);
  const { pickupPressed: _, ...bomb } = packet(1);
  assert.equal(validateGiftInput(bomb), null, "a Bomba Sende packet is not a gift packet");
  const box = new InputMailbox();
  assert.ok(box.accept(packet(1, { pickupPressed: true }), 1, 0, "gift_grab"));
  assert.ok(box.accept(packet(2, { punchPressed: true, viewTick: 90 }), 1, 1, "gift_grab"));
  assert.ok(box.accept(packet(3), 1, 2, "gift_grab"));
  const first = box.read(3);
  assert.deepEqual([first.pickup, first.punch, first.viewTick], [true, true, 90]);
  const second = box.read(4);
  assert.deepEqual([second.pickup, second.punch], [false, false]);
  assert.ok(!box.accept(packet(3), 1, 5, "gift_grab"), "old sequence refused");
});

test("the round simulation: 2–3 players only, slots (not seats) as winner, placements per slot, a dropped player's box falls at its feet", () => {
  for (const slots of [[1, 2], [0, 1, 2]] as PlayerId[][]) {
    const sim = new GiftRoundSimulation(undefined, 3);
    assert.ok(sim.start(slots));
    while (sim.phase !== "playing") sim.step(IDLE);
    const g = sim.game,
      [a, b] = slots;
    g.carrying[a] = true;
    sim.neutralize(a);
    assert.ok(!g.carrying[a]);
    assert.equal(g.boxes.length, 1);
    assert.equal(g.log.at(-1)?.kind, "drop");
    const p = pelvis(g, a);
    assert.ok(Math.hypot(g.boxes[0].x - p.x, g.boxes[0].z - p.z) < 0.6, "at its feet");
    g.home[b] = 2;
    sim.round.tick = GIFT_TICKS.cap - 2;
    for (let i = 0; i < 4; i++) sim.step(IDLE);
    assert.equal(sim.phase, "results");
    assert.equal(sim.winner, b);
    assert.equal(sim.snapshot(PLAYERS.map(() => 0)).winner, b);
    const places = sim.placements();
    assert.equal(places[b], 0);
    for (const { id } of PLAYERS) if (!slots.includes(id)) assert.equal(places[id], -1);
    const snap = sim.snapshot(PLAYERS.map(() => 0));
    assert.equal(snap.v, 25);
    assert.ok(validGiftWire(snap.gift));
    sim.dispose();
  }
  const sim = new GiftRoundSimulation();
  assert.ok(!sim.start([0]));
  sim.dispose();
});

test("Hediye Kapmaca is a 2–3 player mode in Mixed, in the board's mini games and in the Yerel Test Arenası", () => {
  assert.ok(GAME_MODES.includes("gift_grab"));
  assert.equal(MODE_NAMES.gift_grab, "Hediye Kapmaca");
  assert.deepEqual(MODE_PLAYERS.gift_grab, { min: 2, max: 3 });
  assert.ok(LOCAL_ARENA_IDS.includes("gift_grab"));
  for (const count of [2, 3]) {
    const mixed = new MixedRotation(() => 0.4);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("gift_grab"), `Mixed ${count}P`);
    const minis: string[] = [];
    const host: BoardHost = { startMini: (mode) => (minis.push(mode), true), endMini() {}, connected: () => true };
    const rotation = new MixedRotation(() => 0.4);
    rotation.setPlayers(count);
    const board = new BoardSession(host, { length: 50, slots: PLAYERS.slice(0, count).map((p) => p.id), random: () => 0.4, die: () => 1, rotation, squares: boardSquares(50) });
    const until = (done: () => boolean, act = () => board.step(1 / NET.physicsHz)) => {
      for (let t = 0; t < 600 * NET.physicsHz && !done(); t++) act();
      assert.ok(done(), `board stuck in ${board.phase}`);
    };
    while (minis.length < cycle.length) {
      until(() => board.phase === "minigame");
      board.miniResult(-1, null);
      until(() => board.phase !== "minigame");
      until(() => board.phase === "intro", () => (board.phase === "roll" ? board.rollPressed(board.current) : board.step(1 / NET.physicsHz)));
    }
    assert.ok(minis.includes("gift_grab"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
});

/* A real room: a box from a packet, home, a dropped player's box falls, back and taking again. */
const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms: Room<unknown, LobbyState>[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timeout");
    await pause(5);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const r of rooms) {
    r.reconnection.enabled = false;
    if (r.connection.isOpen) await r.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
async function peer(code?: string) {
  const client = new Client(endpoint),
    r = code
      ? await client.joinById<LobbyState>(code, { protocol: NET.version, nickname: "Guest", intent: "join", code })
      : await client.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  r.onMessage("notice", () => {});
  r.onMessage("feedback", () => {});
  const snapshots: GameSnapshot[] = [];
  r.onMessage("snapshot", (s: GameSnapshot) => snapshots.push(s));
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  let seq = 0;
  return {
    r,
    snapshots,
    send: (round: number, extra: Partial<GiftInputPacket> = {}) =>
      r.send("input", { seq: ++seq, round, moveX: 0, moveZ: 0, jumpPressed: false, sprintHeld: false, punchPressed: false, viewTick: 0, pickupPressed: false, ...extra } satisfies GiftInputPacket),
  };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "gift_grab");
  await until(() => room.selection === "gift_grab");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as GiftRoundSimulation;
  assert.ok(sim instanceof GiftRoundSimulation);
  const slot = (p: (typeof peers)[number]) => room.state.players.get(p.r.sessionId)!.slot as PlayerId;
  return { peers, room, sim, slot };
}
async function close(peers: { r: Room<unknown, LobbyState> }[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}

for (const count of [2, 3])
  test(`room ${count}P: Tut from a packet takes a box, home puts it down; a dropped player's box falls, back and taking again; results`, { timeout: 30000 }, async () => {
    const { peers, room, sim, slot } = await lobby(count);
    const g = sim.game,
      s0 = slot(peers[0]),
      s1 = slot(peers[1]);
    await until(() => room.game.phase === "playing");
    // Slot 0 at the pile: a packet's Tut takes one.
    put(g, s0, 0, -(GIFT.pedestal.radius + 0.45));
    await pause(60);
    peers[0].send(sim.roundId, { pickupPressed: true });
    await until(() => g.carrying[s0]);
    assert.equal(g.pile, pileSize(count) - 1);
    peers[0].send(sim.roundId);
    // Home: down at once.
    const home = g.homeOf(s0);
    put(g, s0, home.x, home.z);
    await until(() => g.home[s0] === 1);
    // Slot 1 takes one, then drops: the box falls at its feet; the body stays.
    put(g, s1, 0, GIFT.pedestal.radius + 0.45);
    await pause(60);
    peers[1].send(sim.roundId, { pickupPressed: true });
    await until(() => g.carrying[s1]);
    peers[1].send(sim.roundId);
    const r = peers[1].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    assert.ok(!g.carrying[s1], "the box fell");
    assert.equal(g.boxes.length, 1);
    await until(() => room.state.players.get(id)!.connected);
    assert.equal(room.game, sim);
    // Back: it picks the fallen box up again with its own packet.
    await until(() => g.boxes[0].land <= g.round.tick, 2000);
    const box = g.boxes[0];
    put(g, s1, box.x, box.z + 0.3);
    await pause(60);
    for (let i = 0; i < 5 && !g.carrying[s1]; i++) {
      peers[1].send(sim.roundId, { pickupPressed: true });
      await pause(40);
      peers[1].send(sim.roundId);
      await pause(40);
    }
    assert.ok(g.carrying[s1], "back and taking");
    assert.equal(g.total(), pileSize(count));
    sim.round.tick = GIFT_TICKS.cap - 2;
    await until(() => room.game.phase === "results", 4000);
    assert.equal(room.state.winner, s0, "1 at home beats 0 (+1 carried)");
    assert.equal(sim.placements()[s0], 0);
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 25);
    assert.ok(validGiftWire(shown.gift), "the section survives the wire");
    assert.equal(shown.winner, s0);
    assert.ok(shown.prediction?.gift instanceof Uint8Array, "recipient-only prediction block");
    await close(peers);
  });

test("room: the player left alone wins the round", { timeout: 30000 }, async () => {
  const { peers, room, sim } = await lobby(2);
  await until(() => room.game.phase === "playing");
  peers[1].r.reconnection.enabled = false;
  await peers[1].r.leave();
  await until(() => room.game.phase === "results");
  assert.equal(sim.winner, room.state.players.get(peers[0].r.sessionId)!.slot);
  await close(peers.slice(0, 1));
});
