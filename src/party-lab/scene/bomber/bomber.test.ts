import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import { NET } from "../../../../shared/party-lab/network/protocol";
import { GAME_MODES, MODE_NAMES, MODE_SELECTIONS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { BOMBER as B } from "../../../../shared/party-lab/simulation/bomber/config";
import { BOX, CELLS, OUTER, cellAt, cellCenter, cellIndex, sectorAngle, sectorOf } from "../../../../shared/party-lab/simulation/bomber/arena";
import { BomberRoundSimulation } from "../../../../shared/party-lab/simulation/bomberRound";
import { newRoomCounters } from "../../../../shared/party-lab/simulation/online";
import type { BomberInputPacket } from "../../../../shared/party-lab/network/bomberInput";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import { CHAT_LAYOUT } from "../gameChat";
import { BomberPrediction, LocalBomber, NO_CONTROLS, toScreen, toWorld, viewYaw } from "./source";
import { BOMBER_DPR, BOMBER_INSETS, BOMBER_VIEW, fitBomberCamera } from "./layout";
import { blastTimes, previewLook } from "./preview";
import { BURNING, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";

test("Bombacı is a registered 2–3 player mode on protocol 19, with a local arena and a chat spot", () => {
  assert.equal(NET.version, 19);
  assert.ok(GAME_MODES.includes("bomber") && MODE_SELECTIONS.includes("bomber"));
  assert.equal(MODE_NAMES.bomber, "Bombacı");
  assert.ok(modeFits("bomber", 2) && modeFits("bomber", 3) && !modeFits("bomber", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("bomber"));
  assert.ok(CHAT_LAYOUT.bomber.wide.bottom >= 0);
});

test("controls follow the screen: W walks up it (towards the hub from your start, which sits at the bottom), D to the right", () => {
  for (const players of [2, 3]) {
    const spawns = Array.from({ length: players }, (_, lane) => cellIndex(4, lane * (24 / players) + (24 / players / 2 - 1)));
    spawns.forEach((spawn, lane) => {
      const yaw = viewYaw(spawns, lane),
        a = sectorAngle(sectorOf(spawn)),
        up = toWorld(0, -1, yaw);
      assert.ok(Math.abs(up.x + Math.cos(a)) < 1e-9 && Math.abs(up.z + Math.sin(a)) < 1e-9, "W: from the start towards the hub");
      const right = toWorld(1, 0, yaw);
      assert.ok(Math.abs(right.x * up.x + right.z * up.z) < 1e-9, "D: across");
      const back = toScreen(right.x, right.z, yaw);
      assert.ok(Math.abs(back.x - 1) < 1e-9 && Math.abs(back.z) < 1e-9);
    });
  }
});

test("the camera: from nearly above, the arena looks round and fills the height right of the HUD column, the player's start at the bottom middle", () => {
  for (const [w, h] of [[1280, 800], [1920, 1080], [1440, 900], [2560, 1440], [1024, 768]]) {
    for (const lane of [0, 1, 2]) {
      const spawns = [cellIndex(4, 3), cellIndex(4, 11), cellIndex(4, 19)],
        yaw = viewYaw(spawns, lane),
        camera = new PerspectiveCamera();
      const fit = fitBomberCamera(camera, w, h, yaw),
        insets = BOMBER_INSETS;
      assert.ok(fit.box.x0 >= insets.left - 1 && fit.box.x1 <= w - insets.right + 1, `${w}×${h}: across ${fit.box.x0}–${fit.box.x1}`);
      assert.ok(fit.box.y0 >= insets.top - 1 && fit.box.y1 <= h - insets.bottom + 1, `${w}×${h}: down ${fit.box.y0}–${fit.box.y1}`);
      // Landscape desktops: the arena takes the whole height but the margins.
      if (fit.free.w >= fit.free.h) assert.ok(fit.box.y1 - fit.box.y0 > fit.free.h * 0.98, `${w}×${h}: height ${fit.box.y1 - fit.box.y0} of ${fit.free.h}`);
      // The rim itself (ground level) is a circle, not a flat ellipse.
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2,
          p = new Vector3(Math.cos(a) * OUTER, 0, Math.sin(a) * OUTER).project(camera);
        x0 = Math.min(x0, p.x * w);
        x1 = Math.max(x1, p.x * w);
        y0 = Math.min(y0, p.y * h);
        y1 = Math.max(y1, p.y * h);
      }
      const roundness = (y1 - y0) / (x1 - x0);
      assert.ok(roundness > 0.97 && roundness < 1.03, `${w}×${h}: height/width ${roundness.toFixed(3)}`);
      const at = cellCenter(spawns[lane]),
        p = new Vector3(at.x, 0, at.z).project(camera),
        centre = new Vector3(0, 0, 0).project(camera);
      assert.ok(Math.abs(p.x - centre.x) < 0.01, "start straight below the hub");
      assert.ok(p.y < centre.y - 0.3, "start at the bottom");
    }
  }
  assert.ok(BOMBER_VIEW.tilt <= (10 * Math.PI) / 180, "nearly straight down");
  assert.deepEqual(BOMBER_DPR, [2, 2], "sharp on Retina screens");
});

test("blast preview: every bomb's cells, sooner ones darker; a bomb another blast sets off shows that earlier time", () => {
  const wire = { cells: new Uint8Array(CELLS) } as unknown as BomberWire;
  // A (30 steps) at 2.0 reaches B (150 steps) at 2.2: B's cells blow at 30 too. C (120) alone.
  const times = blastTimes(wire, [{ cell: cellIndex(2, 0), fuse: 30 }, { cell: cellIndex(2, 2), fuse: 150 }, { cell: cellIndex(2, 12), fuse: 120 }]);
  assert.equal(times[cellIndex(2, 0)], 30);
  assert.equal(times[cellIndex(2, 5)], 30, "B's far end, chained");
  assert.equal(times[cellIndex(4, 2)], 30, "B's ray, chained");
  assert.equal(times[cellIndex(2, 12)], 120);
  assert.equal(times[cellIndex(2, 8)], Infinity, "out of every blast");
  // A box stops it (and is not marked); a burning box too.
  const boxed = { cells: new Uint8Array(CELLS) } as unknown as BomberWire;
  boxed.cells[cellIndex(2, 1)] = BOX;
  boxed.cells[cellIndex(1, 0)] = BURNING;
  const t2 = blastTimes(boxed, [{ cell: cellIndex(2, 0), fuse: 60 }]);
  assert.equal(t2[cellIndex(2, 1)], Infinity);
  assert.equal(t2[cellIndex(2, 2)], Infinity);
  assert.equal(t2[cellIndex(0, 0)], Infinity);
  assert.equal(t2[cellIndex(2, 23)], 60);
  // Darker and blinking as the fuse runs out.
  const fresh = previewLook(150, 0),
    late = previewLook(10, 0);
  assert.ok(late.u > fresh.u && late.alpha > fresh.alpha);
  const blinks = [0, 0.03, 0.06, 0.09].map((t) => previewLook(10, t).alpha);
  assert.ok(Math.max(...blinks) - Math.min(...blinks) > 0.1, "blinks near the end");
  assert.equal(previewLook(150, 0).alpha, previewLook(150, 0.3).alpha, "steady when just placed");
});

/** A fixed-latency link: the client predicts at once, the server sees inputs `delay` steps late, snapshots come every 3 steps, `delay` late. */
function link(delay: number) {
  const sim = new BomberRoundSimulation(newRoomCounters(), 11);
  sim.start([0, 1] as PlayerId[]);
  while (sim.phase !== "playing") sim.step([]);
  let prediction: BomberPrediction | null = null;
  const toServer: { at: number; packet: BomberInputPacket }[] = [],
    toClient: { at: number; snapshot: ReturnType<BomberRoundSimulation["snapshot"]> }[] = [];
  let latest: BomberInputPacket | null = null,
    seq = 0,
    clock = 0;
  const first = sim.snapshot([-1, -1, -1]);
  prediction = new BomberPrediction(first.bomber!, 0, 0);
  // One frame, as the arena runs it: the newest snapshot, then this frame's input, then the drawn pose.
  const tick = (moveX: number, moveZ: number, bombs: number) => {
    clock++;
    while (toClient.length && toClient[0].at <= clock) prediction!.reconcile({ snapshot: toClient.shift()!.snapshot, values: new Float32Array(), received: clock * 16.67 }, clock * 16.67);
    const packet: BomberInputPacket = { seq: ++seq, round: sim.roundId, moveX, moveZ, bombs };
    prediction!.step(packet, clock * 16.67);
    prediction!.visual(1 / 60);
    toServer.push({ at: clock + delay, packet });
    while (toServer.length && toServer[0].at <= clock) latest = toServer.shift()!.packet;
    const inputs = [0, 1, 2].map((slot) => ({ x: 0, z: 0, jump: false, bomber: slot === 0 && latest ? latest : undefined }));
    sim.step(inputs);
    if (clock % 3 === 0) toClient.push({ at: clock + delay, snapshot: sim.snapshot([latest?.seq ?? -1, -1, -1]) });
  };
  return { sim, tick, prediction: () => prediction! };
}

test("prediction: own walking and bombs shown at once and replayed exactly (steady 100 ms round trip: no correction at all)", () => {
  const { sim, tick, prediction } = link(3);
  const p = prediction(),
    spawn = sim.game.layout.spawns[0],
    a = sectorAngle(sectorOf(spawn)),
    along = { x: -Math.sin(a), z: Math.cos(a) };
  // Round the pocket: along the ring, then a bomb, then back the other way and in.
  for (let i = 0; i < 25; i++) tick(along.x, along.z, 0);
  const moved = p.game.players[0];
  assert.notEqual(cellAt(moved.x, moved.z), spawn, "walked off the start at once");
  tick(0, 0, 1);
  assert.equal(p.game.bombs.filter((b) => b.owner === 0).length, 1, "own bomb drawn before the server has it");
  for (let i = 0; i < 40; i++) tick(-along.x, -along.z, 1);
  for (let i = 0; i < 30; i++) tick(-Math.cos(a), -Math.sin(a), 1);
  for (let i = 0; i < 20; i++) tick(0, 0, 1);
  const server = sim.game.players[0],
    shown = p.visual(0.016);
  assert.ok(Math.hypot(shown.x - server.x, shown.z - server.z) < 0.02, `settled where the server is (${shown.x},${shown.z} vs ${server.x},${server.z})`);
  assert.equal(p.metrics.hard, 0);
  assert.equal(p.metrics.corrections, 0, `corrections: ${p.metrics.corrections}`);
  assert.ok(p.metrics.maxError < 1e-9, `largest correction ${p.metrics.maxError} m`);
  if (process.env.BOMBER_METRICS) console.log(p.metrics);
  assert.ok(p.metrics.replaySteps > 100, `replayed ${p.metrics.replaySteps} steps`);
  assert.equal(sim.game.players[0].presses, 1, "one bomb press reached the server");
});

test("the local arena: the game runs with bots, pauses while paused, and the player walks up the screen with W", () => {
  const local = new LocalBomber(3, "medium", () => 0.3);
  for (let i = 0; i < 4 * B.hz; i++) local.frame(1 / B.hz, NO_CONTROLS, false);
  assert.equal(local.game.phase, "playing");
  const before = local.game.ticks;
  for (let i = 0; i < 30; i++) local.frame(1 / B.hz, NO_CONTROLS, true);
  assert.equal(local.game.ticks, before, "paused: no steps");
  // Put the player in the ring-2 corridor of its wedge (no pillar inwards) and press W.
  const me = local.game.players[0],
    cell = cellIndex(2, sectorOf(local.game.layout.spawns[0]) - 1);
  Object.assign(me, cellCenter(cell));
  const r0 = Math.hypot(me.x, me.z);
  for (let i = 0; i < 10; i++) local.frame(1 / B.hz, { x: 0, z: -1, bomb: false }, false);
  assert.ok(Math.hypot(me.x, me.z) < r0 - 0.3 || local.game.cells[cellIndex(1, sectorOf(cell))] !== 0, "W walks towards the hub");
  const frame = local.frame(0, NO_CONTROLS, false);
  assert.equal(frame.self, 0);
  assert.ok(Math.abs(frame.yaw - viewYaw(local.game.layout.spawns, 0)) < 1e-12);
});
