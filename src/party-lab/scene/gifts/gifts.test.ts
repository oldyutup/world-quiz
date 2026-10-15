import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics } from "../../../../shared/party-lab/simulation/physics";
import { GiftRoundSimulation } from "../../../../shared/party-lab/simulation/giftRound";
import { GIFT, GIFT_TICKS } from "../../../../shared/party-lab/simulation/gifts/config";
import { decodeGiftWire } from "../../../../shared/party-lab/simulation/gifts/wire";
import { readGiftPredictionState } from "../../../../shared/party-lab/simulation/predictionState";
import { newRoomCounters } from "../../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { homeCenter } from "../../../../shared/party-lab/maps/gifts";
import { GIFT_PREDICTION_BYTES, NET, type GameSnapshot, type GiftInputPacket } from "../../../../shared/party-lab/network/protocol";
import { GAME_MODES, MODE_NAMES } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import { GiftPredictionRig, canPredictGift } from "../../network/prediction/giftRig";
import { CHAT_LAYOUT } from "../gameChat";
import { GIFT_ACTION_LABELS } from "../../input/actions";
import { giftCallout, giftPlaces, giftSecondsLeft } from "./hud";
import { LocalGift, NO_GIFT_CONTROLS, viewYaw, worldIntent } from "./source";

before(() => initializePhysics());
const IDLE = [{ x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }];
const dir = fileURLToPath(new URL(".", import.meta.url));

function match(slots: PlayerId[] = [0, 1]) {
  const sim = new GiftRoundSimulation(newRoomCounters(), 5);
  assert.ok(sim.start(slots));
  while (sim.phase === "countdown") sim.step(IDLE);
  return sim;
}
function poses(snapshot: GameSnapshot) {
  const bytes = snapshot.transforms,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

test("Hediye Kapmaca is a registered 2–3 player mode on protocol 25: local arena, chat spot, lobby hint, online view, Tut labelled", () => {
  assert.equal(NET.version, 25);
  assert.ok(GAME_MODES.includes("gift_grab"));
  assert.equal(MODE_NAMES.gift_grab, "Hediye Kapmaca");
  assert.ok(LOCAL_ARENA_IDS.includes("gift_grab"));
  assert.ok(CHAT_LAYOUT.gift_grab.wide.bottom >= 16);
  assert.equal(GIFT_ACTION_LABELS.grab, "Kutu al");
  const lobby = readFileSync(`${dir}../../PartyLobby.tsx`, "utf8"),
    online = readFileSync(`${dir}../OnlineArena.tsx`, "utf8"),
    arena = readFileSync(`${dir}../OnlineGiftArena.tsx`, "utf8"),
    local = readFileSync(`${dir}../ArenaScene.tsx`, "utf8");
  assert.match(lobby, /gift_grab: "/);
  assert.match(online, /"gift_grab"\) return .*OnlineGiftArena/);
  assert.match(arena, /menu\.chatOpen/, "the chat cuts the input");
  assert.match(local, /mapId === "gift_grab"/);
});

test("controls: the view puts this player's home at the bottom; W walks up the screen toward the pile, D to the right", () => {
  for (const players of [2, 3] as const)
    for (let seat = 0; seat < players; seat++) {
      const yaw = viewYaw({ seats: [0, 1, 2].slice(0, players), players }, seat),
        home = homeCenter(players, seat),
        up = worldIntent({ ...NO_GIFT_CONTROLS, z: -1 }, yaw),
        right = worldIntent({ ...NO_GIFT_CONTROLS, x: 1 }, yaw);
      // From the home, "up" points at the middle.
      assert.ok(Math.abs(up.x + home.x / GIFT.homes.distance) < 1e-9 && Math.abs(up.z + home.z / GIFT.homes.distance) < 1e-9, `${players}P seat ${seat}`);
      assert.ok(Math.abs(up.x * right.x + up.z * right.z) < 1e-9, "right is square to up");
    }
  const intent = worldIntent({ x: 0, z: 0, jump: false, punch: true, pickup: true }, 0);
  assert.deepEqual([intent.punch, intent.pickup, intent.jump], [true, true, false]);
});

test("prediction: the rig replays the server's own body (walking, a stun, a box carried home) within a few centimetres", () => {
  const sim = match([0, 1]);
  const g = sim.game;
  for (const [id, x] of [[0, -2], [1, 4]] as const) {
    const c = sim.physics.players[id];
    restore(c, { x, y: 0.9, z: 3 }, 0);
    connect(sim.physics.world, c);
  }
  sim.step(IDLE);
  g.carrying[0] = true;
  sim.step(IDLE);
  const snapshot = { ...sim.snapshot([-1, -1, -1]), prediction: sim.prediction(0) };
  assert.equal(snapshot.prediction.gift?.byteLength, GIFT_PREDICTION_BYTES);
  assert.equal(readGiftPredictionState(snapshot.prediction.gift)?.carrying, 1);
  assert.ok(canPredictGift(snapshot, 0));
  const rig = new GiftPredictionRig(0);
  assert.ok(rig.restore(snapshot, poses(snapshot)));
  let maxError = 0;
  for (let i = 0; i < 90; i++) {
    const input = { x: 0.3, z: 0.8, jump: i === 30, punch: i === 10 };
    sim.step([input, IDLE[1], IDLE[2]]);
    rig.step(input);
    const a = sim.physics.players[0].body.translation(),
      b = rig.character.body.translation();
    maxError = Math.max(maxError, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  assert.equal(rig.fighter.punch.age, sim.game.brawl.fighters[0].punch.age, "the carrier's punch was refused on both sides");
  console.log(JSON.stringify({ giftPredictionMaxErrorM: +maxError.toFixed(5), carrying: { server: g.carrying[0], rig: rig.carrying } }));
  assert.ok(maxError < 0.05, `${maxError} m`);
  assert.equal(rig.carrying, g.carrying[0], "home: both put the box down");
  rig.dispose();
  // A stun: neither side walks.
  g.stun[0] = GIFT_TICKS.stun;
  g.brawl.fighters[0].stagger = { time: GIFT.stun.time, posture: GIFT.stun.posture, mobility: GIFT.stun.mobility };
  sim.step(IDLE);
  const stunned = { ...sim.snapshot([-1, -1, -1]), prediction: sim.prediction(0) },
    rig2 = new GiftPredictionRig(0);
  assert.ok(rig2.restore(stunned, poses(stunned)));
  // It was walking: it brakes to a stop, then stays however it is steered.
  const steered = { x: 1, z: 0, jump: false };
  for (let i = 0; i < 18; i++) {
    sim.step([steered, IDLE[1], IDLE[2]]);
    rig2.step(steered);
  }
  const start = { ...rig2.character.body.translation() };
  for (let i = 0; i < 25; i++) {
    sim.step([steered, IDLE[1], IDLE[2]]);
    rig2.step(steered);
  }
  const p = rig2.character.body.translation(),
    s = sim.physics.players[0].body.translation();
  assert.ok(Math.hypot(p.x - start.x, p.z - start.z) < 0.15, `stunned: no walking (${Math.hypot(p.x - start.x, p.z - start.z).toFixed(3)} m)`);
  assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05);
  rig2.dispose();
  sim.dispose();
});

test("the gift packet is small and strict", () => {
  const packet: GiftInputPacket = { seq: 9999, round: 4, moveX: 0.6, moveZ: -0.8, jumpPressed: false, sprintHeld: false, punchPressed: true, viewTick: 123456, pickupPressed: true };
  const bytes = new Packr({ useRecords: false }).pack(packet).byteLength;
  console.log(JSON.stringify({ giftInputBytes: bytes }));
  assert.ok(bytes < 140, `${bytes} B`);
  const snapshot = match([0, 1, 2]).snapshot([-1, -1, -1]);
  assert.ok(decodeGiftWire(snapshot.gift));
});

test("Yerel Test Arenası: you and 1–2 bots of a level; the round plays (the bots take boxes) and the result stays until a new round", () => {
  for (const players of [2, 3] as const) {
    const local = new LocalGift(players, "hard", 17);
    assert.deepEqual(local.game.seats, [0, 1, 2].slice(0, players));
    assert.equal(local.bots.length, players - 1);
    let frame = local.frame(0, NO_GIFT_CONTROLS, false)!;
    assert.equal(frame.phase, "countdown");
    assert.equal(frame.self, 0);
    for (let i = 0; i < 60 * 47 && frame.phase !== "results"; i++) frame = local.frame(1 / 60, NO_GIFT_CONTROLS, false)!;
    assert.equal(frame.phase, "results");
    assert.ok(local.game.stats.pile > 0, "the bots took boxes");
    assert.equal(local.game.home[0], 0, "nobody played slot 0");
    assert.notEqual(frame.winner, 0, "the idle player never wins");
    const tick = local.game.round.tick;
    for (let i = 0; i < 600; i++) local.frame(1 / 60, NO_GIFT_CONTROLS, false);
    assert.equal(local.game.round.phase, "results");
    assert.equal(local.game.round.tick, tick, "the result stays");
    local.dispose();
  }
  // The menu pauses the local round.
  const paused = new LocalGift(3, "medium", 3);
  const before = paused.game.round.tick;
  for (let i = 0; i < 60; i++) paused.frame(1 / 60, NO_GIFT_CONTROLS, true);
  assert.equal(paused.game.round.tick, before);
  paused.dispose();
});

test("HUD: seconds left, places (a leaver last, ties share), and this player's callouts", () => {
  assert.equal(giftSecondsLeft(0), 40);
  assert.equal(giftSecondsLeft(60 * 39.5), 0.5);
  const sim = match([0, 1, 2]);
  sim.game.home[0] = 3;
  sim.game.home[1] = 3;
  sim.game.home[2] = 5;
  sim.remove(2);
  const gift = decodeGiftWire(sim.snapshot([-1, -1, -1]).gift)!;
  assert.deepEqual(giftPlaces(gift), [0, 0, 2]);
  const e = (kind: "steal" | "knock" | "deposit", actor: number, owner: number, id: number) => ({ id, tick: 0, kind, actor, owner, x: 0, z: 0, box: -1 });
  assert.equal(giftCallout([e("steal", 1, 0, 1)], 0)?.text, "Kutun çalındı!");
  assert.equal(giftCallout([e("knock", 0, 2, 2)], 0)?.text, "Kutun düştü!");
  assert.equal(giftCallout([e("steal", 0, 1, 3)], 0)?.text, "Çaldın!");
  assert.equal(giftCallout([e("knock", 1, 0, 4)], 0)?.text, "Düşürdün!");
  assert.equal(giftCallout([e("deposit", 0, -1, 5), e("steal", 1, 2, 6)], 0), null);
  sim.dispose();
});
