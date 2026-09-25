import assert from "node:assert/strict";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { initializePhysics, IDLE_INPUT, PlaygroundPhysics } from "./physics";
import { CombatSimulation } from "./combat";
import { LocalRoundSimulation } from "./localRound";
import { LocalBot, botArena, nearestLethalEdge, steerAround, type BotObservation } from "./bots";
import { restore } from "./ragdoll/character";
import { PARTS, RAGDOLL } from "./ragdoll/config";
import { PLAYERS, type PlayerId } from "./players";
import type { MovementInput } from "../input/types";
import { createArenaWorld } from "../../../shared/party-lab/simulation/world";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound";
import { capturePredictionState } from "../../../shared/party-lab/simulation/predictionState";
import { InputMailbox, NET, type GameSnapshot, type InputPacket } from "../../../shared/party-lab/network/protocol";
import { MODE_MAP } from "../../../shared/party-lab/modes";
import {
  ARENA_MAPS,
  DEFAULT_ARENA_MAP_ID,
  ONLINE_ARENA_MAP_ID,
  arenaMap,
  isArenaMapId,
  rampHull,
  type BoxCollider,
  type ColliderRole,
} from "../../../shared/party-lab/maps";
import {
  ACCESS_BUILDING,
  CONDENSER,
  DECK,
  ROOF,
  ROOFTOP_MAP,
  STAIRS,
} from "../../../shared/party-lab/maps/rooftop";
import { SnapshotBuffer } from "../network/gameStream";
import { LocalPrediction } from "../network/prediction/localPrediction";
import { PredictionRig } from "../network/prediction/rig";
import {
  BACKDROP,
  BACKDROP_CLEARANCE,
  HAZARD_STRIPES,
  HAZE_Y,
  WATER_TANK,
} from "./arenas/rooftopScenery";
import { WorldGeometry } from "./arenas/worldGeometry";

before(() => initializePhysics());

const map = ROOFTOP_MAP;
const boxes = (role: ColliderRole) =>
  map.colliders.filter((c): c is BoxCollider => c.role === role && c.shape === "box");
const top = (c: BoxCollider) => c.center.y + c.half.y;
const span = (c: BoxCollider, axis: "x" | "y" | "z") => [c.center[axis] - c.half[axis], c.center[axis] + c.half[axis]];
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

function withRoof(check: (p: PlaygroundPhysics, events: string[]) => void) {
  const events: string[] = [];
  const p = new PlaygroundPhysics((e) => events.push(e.name), map);
  try {
    check(p, events);
  } finally {
    p.dispose();
  }
}
/** Park the other two characters far below so only player 0 interacts (they stay disabled). */
function solo(p: PlaygroundPhysics, keep: PlayerId[] = [0]) {
  for (const c of p.players) {
    if (keep.includes(c.id)) continue;
    c.eliminated = true;
    for (const part of Object.values(c.parts)) part.body.setEnabled(false);
  }
}
function run(p: PlaygroundPhysics, seconds: number, input: (t: number) => MovementInput = () => IDLE_INPUT, who: PlayerId = 0) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const inputs = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
    inputs[who] = input(i / 60);
    p.step(inputs);
  }
}
const pelvis = (p: PlaygroundPhysics, id: PlayerId = 0) => p.players[id].body.translation();
const facing = (x: number, z: number) => Math.atan2(x, z);

// ─── Map data ────────────────────────────────────────────────────────────────

test("rooftop is the local default and Rooftop Brawl's online map; ids are validated", () => {
  assert.equal(DEFAULT_ARENA_MAP_ID, "rooftop");
  assert.equal(ONLINE_ARENA_MAP_ID, "rooftop");
  assert.equal(MODE_MAP.rooftop_brawl, "rooftop");
  assert.equal(arenaMap("rooftop"), map);
  assert.deepEqual(Object.keys(ARENA_MAPS).sort(), ["barn", "rooftop", "test"]);
  assert.ok(isArenaMapId("test") && isArenaMapId("rooftop"));
  assert.ok(!isArenaMapId("toString") && !isArenaMapId("") && !isArenaMapId(3));
  // 5 = Barn; 6 = Katman; 7 = Renk; 8 = Bomba Sende online.
  // Rooftop Brawl's wire content is unchanged apart from `mode`.
  assert.equal(NET.version, 8);
});

test("rooftop data is finite, inside the 14 × 11 m roof and matches the audited layout", () => {
  assert.equal(ROOF.maxX - ROOF.minX, 14);
  assert.equal(ROOF.maxZ - ROOF.minZ, 11);
  assert.equal(map.colliders.length, 10);
  for (const c of map.colliders) {
    const values = c.shape === "cylinder" ? [c.center.x, c.center.y, c.center.z, c.radius, c.halfHeight] : [...Object.values(c.center), ...Object.values(c.half)];
    assert.ok(values.every(Number.isFinite), c.role);
    if (c.shape !== "cylinder") {
      assert.ok(c.half.x > 0 && c.half.y > 0 && c.half.z > 0, c.role);
      assert.ok(c.center.x - c.half.x >= ROOF.minX - 1e-9 && c.center.x + c.half.x <= ROOF.maxX + 1e-9, `${c.role} x`);
      assert.ok(c.center.z - c.half.z >= ROOF.minZ - 1e-9 && c.center.z + c.half.z <= ROOF.maxZ + 1e-9, `${c.role} z`);
    }
  }
  const [floor] = boxes("floor");
  assert.equal(top(floor), 0);
  assert.ok(floor.center.y - floor.half.y > RAGDOLL.fallY, "the slab ends above the elimination height, never below it");
  // Safe back wall: 1.6 m full width, and 1.6 m above the deck behind the stairs and deck.
  const [wall, course] = boxes("parapet");
  assert.deepEqual(span(wall, "x"), [-7, 7]);
  assert.equal(top(wall), 1.6);
  assert.deepEqual(span(course, "x"), [STAIRS.x[0], 7]);
  assert.equal(top(course), 2.6);
  // Raised deck and building.
  const [deck] = boxes("deck");
  assert.equal(top(deck), 1);
  assert.deepEqual(span(deck, "x"), [3.5, 7]);
  const [building] = boxes("building");
  assert.deepEqual(span(building, "x"), [...ACCESS_BUILDING.x]);
  assert.ok(top(building) > top(course), "unreachable from the roof or deck");
  // Two mirrored 1.78 × 1.2 × 0.7 m condensers.
  const condensers = boxes("condenser");
  assert.equal(condensers.length, 2);
  for (const c of condensers) {
    assert.ok(close(c.half.x * 2, 1.78) && close(c.half.y * 2, 1.2) && close(c.half.z * 2, 0.7));
    assert.equal(Math.abs(c.center.x), CONDENSER.x);
  }
  assert.equal(condensers[0].center.x, -condensers[1].center.x);
  // Front: two 0.3 m curbs with an open 4 m gap.
  const curbs = boxes("curb");
  assert.deepEqual(curbs.map((c) => span(c, "x")), [[-7, -2], [2, 7]]);
  for (const c of curbs) assert.ok(close(top(c), 0.3) && close(span(c, "z")[1], ROOF.maxZ));
  // One ramp, rising 1 m toward the deck over 2 m (26.6°).
  const ramps = map.colliders.filter((c) => c.shape === "ramp");
  assert.equal(ramps.length, 1);
  const hull = rampHull(ramps[0] as never);
  assert.equal(hull.length, 6);
  const high = hull.filter((p) => p.y === 1);
  assert.ok(high.length === 2 && high.every((p) => p.x === DECK.x[0]));
  const slope = (Math.atan2(1, STAIRS.x[1] - STAIRS.x[0]) * 180) / Math.PI;
  assert.ok(slope > 26 && slope < 27);
});

test("clear gaps: obstacles are ≥ 1.5 m apart or touching, never a narrow ragdoll trap", () => {
  const solid = map.colliders.filter((c): c is BoxCollider => c.shape === "box" && ["building", "deck", "condenser", "parapet"].includes(c.role));
  const footprints = [
    ...solid.map((c) => ({ role: c.role, x: span(c, "x"), z: span(c, "z") })),
    { role: "stairs", x: [...STAIRS.x], z: [...STAIRS.z] },
  ];
  for (let i = 0; i < footprints.length; i++)
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i],
        b = footprints[j];
      const gx = Math.max(a.x[0] - b.x[1], b.x[0] - a.x[1], 0),
        gz = Math.max(a.z[0] - b.z[1], b.z[0] - a.z[1], 0);
      const gap = Math.hypot(gx, gz);
      assert.ok(gap < 1e-6 || gap >= 1.5, `${a.role}/${b.role} gap ${gap.toFixed(2)} m`);
    }
  // Side passages between each condenser and its open edge.
  assert.ok(close(ROOF.maxX - (CONDENSER.x + CONDENSER.halfX), 1.51, 1e-6));
});

test("spawns: equilateral 5.2 m, mirrored slots 0/1, clear of every collider and lethal edge", () => {
  const [a, b, c] = map.spawns;
  for (const [p, q] of [[a, b], [a, c], [b, c]]) assert.ok(close(Math.hypot(p.x - q.x, p.z - q.z), 5.2, 0.005));
  assert.ok(a.x === -b.x && a.z === b.z && c.x === 0);
  for (const s of map.spawns) {
    assert.equal(s.y, 1.6);
    for (const collider of map.colliders) {
      if (collider.role === "floor" || collider.shape === "cylinder") continue;
      const gx = Math.max(collider.center.x - collider.half.x - s.x, s.x - (collider.center.x + collider.half.x), 0),
        gz = Math.max(collider.center.z - collider.half.z - s.z, s.z - (collider.center.z + collider.half.z), 0);
      assert.ok(Math.hypot(gx, gz) >= 1.5, `${collider.role} too close to spawn ${s.x},${s.z}`);
    }
    assert.ok(nearestLethalEdge(botArena(map), s.x, s.z)!.distance >= 3);
  }
});

// ─── Physics world built from the data ──────────────────────────────────────

test("server authority, client prediction and local mode build the identical static rooftop", () => {
  const describe = (world: RAPIER.World) => {
    const out: string[] = [];
    world.forEachCollider((c) => {
      if (c.parent()) return;
      const t = c.translation(),
        aabb = c.shape.type === RAPIER.ShapeType.ConvexPolyhedron ? "hull" : JSON.stringify((c.shape as RAPIER.Cuboid).halfExtents ?? null);
      out.push(`${c.shape.type}|${t.x.toFixed(4)},${t.y.toFixed(4)},${t.z.toFixed(4)}|${aabb}|${c.friction()}`);
    });
    return out.sort();
  };
  const server = new OnlineRoundSimulation(),
    rig = new PredictionRig(0),
    local = new LocalRoundSimulation(() => 0.5),
    reference = createArenaWorld(map);
  try {
    const expected = describe(reference);
    assert.equal(expected.length, 10);
    assert.deepEqual(describe(server.physics.world), expected);
    assert.deepEqual(describe(rig.world), expected);
    assert.deepEqual(describe(local.physics.world), expected);
    assert.equal(server.physics.map.id, "rooftop");
    assert.equal(rig.map.id, "rooftop");
  } finally {
    server.dispose();
    rig.dispose();
    local.dispose();
    reference.free();
  }
});

test("authoritative online rounds start and reset every slot on its rooftop spawn", () => {
  const s = new OnlineRoundSimulation();
  try {
    const atSpawns = () =>
      s.physics.players.every((c) => {
        const b = c.body.translation(),
          spawn = map.spawns[c.id];
        return Math.hypot(b.x - spawn.x, b.z - spawn.z) < 1e-4 && Math.abs(b.y - spawn.y) < 1e-4;
      });
    assert.ok(s.start([0, 1, 2]));
    assert.ok(atSpawns(), "round 1 starts on the rooftop spawns");
    for (let i = 0; i < 400; i++) s.step([{ x: 1, z: 0, jump: false }, { x: -1, z: 0, jump: false }, { x: 0, z: 1, jump: false }]);
    for (const c of s.physics.players) restore(c, { x: c.id * 2, y: -6, z: 0 }, 0);
    for (let i = 0; i < 60 * 5 && s.phase !== "waiting"; i++) s.step([]);
    assert.equal(s.phase, "waiting");
    assert.ok(s.start([0, 1]));
    assert.ok(atSpawns(), "the next round resets to the rooftop spawns");
  } finally {
    s.dispose();
  }
});

test("surface heights from raycasts: roof 0, curb 0.3, deck 1, stairs mid 0.5, void past every lethal edge", () => {
  const world = createArenaWorld(map);
  try {
    world.step();
    const floorAt = (x: number, z: number) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 10, z }, { x: 0, y: -1, z: 0 }), 100, true);
      return hit ? 10 - hit.timeOfImpact : null;
    };
    for (const s of map.spawns) assert.ok(close(floorAt(s.x, s.z)!, 0, 1e-4));
    assert.ok(close(floorAt(-4.5, 4.35)!, 0.3, 1e-4));
    assert.ok(close(floorAt(0, 4.4)!, 0, 1e-4), "centre gap has no curb");
    assert.ok(close(floorAt(5.25, -4.6)!, 1, 1e-4));
    assert.ok(close(floorAt(2.5, -5.1)!, 0.5, 1e-3));
    assert.ok(close(floorAt(0, -6.3)!, 1.6, 1e-4));
    assert.ok(close(floorAt(3, -6.3)!, 2.6, 1e-4));
    // Nothing under any lethal edge: a falling body meets no ledge before fallY.
    for (const edge of map.lethalEdges)
      for (let t = 0; t <= 1; t += 0.05)
        for (const out of [0.05, 0.5, 1.5, 3]) {
          const x = edge.from.x + (edge.to.x - edge.from.x) * t + edge.outward.x * out,
            z = edge.from.z + (edge.to.z - edge.from.z) * t + edge.outward.z * out;
          assert.equal(floorAt(x, z), null, `surface under lethal edge at ${x.toFixed(2)},${z.toFixed(2)}`);
        }
  } finally {
    world.free();
  }
});

// ─── Edge behaviour with the real ragdoll ───────────────────────────────────

test("everyone stands at the rooftop spawns; idle players never fall", () =>
  withRoof((p) => {
    run(p, 3);
    for (const c of p.players) {
      assert.equal(c.eliminated, false);
      assert.ok(p.isGrounded(c.id));
      assert.ok(Math.abs(c.body.translation().y - 0.78) < 0.08);
    }
  }));

test("open edges are lethal: left side and the centre-front gap eliminate with a fall cue", () => {
  for (const [start, dir] of [
    [{ x: -5, y: 1, z: 1.3 }, { x: -1, z: 0 }],
    [{ x: 0, y: 1, z: 2.5 }, { x: 0, z: 1 }],
    [{ x: 5, y: 1, z: 2 }, { x: 1, z: 0 }],
  ] as const)
    withRoof((p, events) => {
      solo(p);
      restore(p.players[0], start, facing(dir.x, dir.z));
      run(p, 0.5);
      run(p, 3, () => ({ ...IDLE_INPUT, ...dir }));
      assert.equal(p.players[0].eliminated, true);
      assert.ok(events.includes("fall"));
    });
});

test("safe wall: straight and angled jump-spam into the back wall (roof, alley, stairs, deck) never gets over", () => {
  const starts = [
    { x: 0, y: 1, z: -4.3 },
    { x: -0.6, y: 1, z: -3.2 },
    { x: -6.3, y: 1, z: -4 },
    { x: 5.2, y: 1.9, z: -4.2 },
    { x: 2.9, y: 1.6, z: -5.2 },
  ];
  for (const start of starts)
    for (const angle of [0, 20, -35, 50])
      withRoof((p) => {
        solo(p);
        const a = (angle * Math.PI) / 180,
          dir = { x: Math.sin(a) * (start.x < -6 ? -Math.sign(angle) || 0 : 1), z: -Math.cos(a) };
        restore(p.players[0], start, facing(dir.x, dir.z));
        run(p, 0.6);
        // Keep pushing into the wall; stop the sideways drift before an open side edge.
        run(p, 6, () => ({ x: Math.abs(pelvis(p).x) > 5.8 ? 0 : dir.x, z: dir.z, jump: true }));
        assert.ok(pelvis(p).z > ROOF.minZ, `got over the wall from ${start.x},${start.z} at ${angle}°`);
        assert.equal(p.players[0].eliminated, false, `fell from ${start.x},${start.z} at ${angle}°`);
      });
});

test("low curb: stops a 4 m/s knockback slide, but a shove still carries an idle player over", () => {
  withRoof((p) => {
    solo(p);
    restore(p.players[0], { x: 4.5, y: 1, z: 3.4 }, 0);
    run(p, 0.8);
    for (const name of PARTS) p.players[0].parts[name].body.setLinvel({ x: 0, y: 0, z: 4 }, true);
    run(p, 3);
    assert.equal(p.players[0].eliminated, false);
  });
  withRoof((p) => {
    solo(p, [0, 1]);
    restore(p.players[1], { x: 4.5, y: 1, z: 3.9 }, 0);
    restore(p.players[0], { x: 4.5, y: 1, z: 1.4 }, 0);
    run(p, 0.6);
    run(p, 3, (t) => (t < 2.6 ? { x: 0, z: 1, jump: false } : { x: 0, z: -1, jump: false }));
    assert.equal(p.players[1].eliminated, true, "shoved target goes over the 0.3 m curb");
  });
});

test("carry-drop: a knocked-out opponent carried to the curb and released falls; the carrier stays", () => {
  const p = new PlaygroundPhysics(undefined, map),
    combat = new CombatSimulation(p);
  try {
    solo(p, [0, 1]);
    restore(p.players[0], { x: 4.5, y: 1.6, z: 1.2 }, 0);
    restore(p.players[1], { x: 4.5, y: 1.6, z: 2.2 }, Math.PI);
    let phase = "settle",
      t = 0;
    for (let i = 0; i < 60 * 7; i++) {
      t += RAGDOLL.step;
      if (phase !== "settle") Object.assign(combat.players[1].condition, { state: "KNOCKED_OUT", remaining: 2, meter: 100 });
      let a: MovementInput = IDLE_INPUT;
      if (phase === "settle" && t > 0.6) (phase = "grab"), (t = 0);
      if (phase === "grab") {
        a = { x: 0, z: 0.15, jump: false, grab: true };
        if (combat.grips.count(0) >= 2) (phase = "lift"), (t = 0);
      }
      if (phase === "lift") {
        a = { x: 0, z: 0, jump: false, grab: true, lift: true };
        if (t > 0.6) (phase = "carry"), (t = 0);
      }
      if (phase === "carry") {
        a = { x: 0, z: 1, jump: false, grab: true, lift: true };
        if (pelvis(p).z > ROOF.maxZ - 0.9) (phase = "release"), (t = 0);
      }
      if (phase === "release") {
        a = { x: 0, z: 1, jump: false, grab: false, lift: true };
        if (t > 0.1) (phase = "back"), (t = 0);
      }
      if (phase === "back") a = t < 0.8 ? { x: 0, z: -1, jump: false } : IDLE_INPUT;
      const inputs = [a, IDLE_INPUT, IDLE_INPUT];
      p.step(inputs, combat.step(inputs, RAGDOLL.step, "playing"));
      combat.afterStep();
    }
    assert.ok(combat.stats.lifts > 0, "the target was lifted");
    assert.ok(p.players.every((c) => c.sprint === 0), "Lift (Shift) never sprints on the rooftop");
    assert.equal(p.players[1].eliminated, true, "dropped over the curb");
    assert.equal(p.players[0].eliminated, false, "carrier stays on the roof");
  } finally {
    combat.stop();
    p.dispose();
  }
});

test("Shift keeps its rooftop meaning: holding Lift while walking changes nothing, and walking speed is unchanged", () => {
  // Rooftop input never carries `sprint` (only the barn maps Lift to it); the character's walk is bit-identical.
  const walk = (extra: Partial<MovementInput>) => {
    const trace: number[] = [];
    withRoof((p) => {
      solo(p);
      restore(p.players[0], { x: -5, y: 1, z: 3.6 }, facing(1, 0));
      run(p, 0.5);
      run(p, 1.6, (t) => ({ x: 1, z: Math.sin(t * 3) * 0.3, jump: false, ...extra }));
      for (const name of PARTS) {
        const b = p.players[0].parts[name].body, q = b.translation(), v = b.linvel();
        trace.push(q.x, q.y, q.z, v.x, v.y, v.z);
      }
      trace.push(p.players[0].facing, p.players[0].gait, p.players[0].sprint);
    });
    return trace;
  };
  const plain = walk({});
  assert.deepEqual(walk({ lift: true }), plain, "Lift alone does not change movement");
  assert.deepEqual(walk({ sprint: false }), plain, "an explicit non-sprint is the plain walk");
  assert.equal(plain[plain.length - 1], 0, "sprint blend stays 0");
  withRoof((p) => {
    solo(p);
    restore(p.players[0], { x: -6, y: 1, z: 3.6 }, facing(1, 0));
    run(p, 0.5);
    run(p, 0.8, () => ({ x: 1, z: 0, jump: false, lift: true }));
    const a = { ...pelvis(p) };
    run(p, 0.8, () => ({ x: 1, z: 0, jump: false, lift: true }));
    const speed = (pelvis(p).x - a.x) / 0.8;
    assert.ok(Math.abs(speed - RAGDOLL.speed) < 0.25, `rooftop walking speed ${speed.toFixed(2)} m/s`);
  });
});

test("stairs and deck are traversable; the deck's open right side is lethal, its front drop is not", () => {
  withRoof((p) => {
    solo(p);
    restore(p.players[0], { x: 0.4, y: 1, z: -5.1 }, facing(1, 0));
    run(p, 0.6);
    run(p, 2, () => ({ x: pelvis(p).x < 4.4 ? 1 : 0, z: 0, jump: false }));
    assert.ok(pelvis(p).y > 1.6 && pelvis(p).x > DECK.x[0], `on the deck: ${JSON.stringify(pelvis(p))}`);
    run(p, 0.8, () => ({ x: 0, z: 1, jump: false }));
    run(p, 1);
    assert.equal(p.players[0].eliminated, false);
    assert.ok(pelvis(p).y < 1 && pelvis(p).z > DECK.z[1], "dropped safely to the roof");
  });
  withRoof((p) => {
    solo(p);
    restore(p.players[0], { x: 5, y: 1.9, z: -4.6 }, facing(1, 0));
    run(p, 0.6);
    assert.ok(pelvis(p).y > 1.6, "standing on the deck");
    run(p, 3, () => ({ x: 1, z: 0, jump: false }));
    assert.equal(p.players[0].eliminated, true);
  });
});

test("condensers block walking, can be vaulted, and their side passages are walkable", () => {
  withRoof((p) => {
    solo(p);
    restore(p.players[0], { x: CONDENSER.x, y: 1, z: 0.8 }, Math.PI);
    run(p, 0.6);
    run(p, 2.5, () => ({ x: 0, z: -1, jump: false }));
    assert.ok(pelvis(p).z > CONDENSER.z + CONDENSER.halfZ, "walker blocked in front");
    // A short run-up and a jump at the face gets over (or onto, then off) it.
    run(p, 0.35, () => ({ x: 0, z: 1, jump: false }));
    run(p, 3, () => ({ x: 0, z: pelvis(p).z > -2.4 ? -1 : 0, jump: pelvis(p).z - (CONDENSER.z + CONDENSER.halfZ) < 0.9 }));
    assert.ok(pelvis(p).z < CONDENSER.z - CONDENSER.halfZ, "jumper vaulted over");
    assert.equal(p.players[0].eliminated, false);
  });
  withRoof((p) => {
    solo(p);
    const lane = (CONDENSER.x + CONDENSER.halfX + ROOF.maxX) / 2;
    restore(p.players[0], { x: lane, y: 1, z: 1.2 }, Math.PI);
    run(p, 0.6);
    run(p, 0.95, () => ({ x: 0, z: -1, jump: false }));
    assert.equal(p.players[0].eliminated, false);
    assert.ok(pelvis(p).z < CONDENSER.z - CONDENSER.halfZ, "passed the condenser along the 1.5 m lane");
  });
});

// ─── Bots ───────────────────────────────────────────────────────────────────

test("bot arena: lethal edges exclude the safe back; carrying heads out through the nearest open edge", () => {
  const arena = botArena(map);
  assert.equal(arena.lethalEdges.length, 3);
  assert.ok(arena.lethalEdges.every((e) => e.outward.z >= 0), "back parapet is never a target");
  assert.deepEqual(nearestLethalEdge(arena, 5.8, 1)!.edge.outward, { x: 1, z: 0 });
  assert.deepEqual(nearestLethalEdge(arena, 0, 3)!.edge.outward, { x: 0, z: 1 });
  // Obstacles: parapets, building, deck, condensers; stairs and curbs stay walkable.
  assert.equal(arena.obstacles.length, 6);
  // Heading straight into a condenser slides along it instead.
  const v = steerAround(arena, CONDENSER.x, 0.4, 0, -1);
  assert.ok(Math.abs(v.x) > 0.5, `deflected: ${JSON.stringify(v)}`);
});

function botRun(seed: number, seconds: number, start: { x: number; y: number; z: number }) {
  let s = seed;
  const random = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const p = new PlaygroundPhysics(undefined, map),
    bot = new LocalBot(1, random),
    arena = botArena(map);
  solo(p, [1]);
  restore(p.players[1], start, 0);
  bot.reset();
  const obs: BotObservation[] = PLAYERS.map((pl) => ({
    id: pl.id, x: 0, z: 0, alive: false, grounded: false, state: "CONSCIOUS", cooldowns: [0, 0], grips: [null, null], grabbedBy: null,
  }));
  let travelled = 0,
    last = pelvis(p, 1);
  try {
    for (let i = 0; i < seconds * 60; i++) {
      const b = pelvis(p, 1);
      Object.assign(obs[1], { x: b.x, z: b.z, alive: !p.players[1].eliminated, grounded: p.isGrounded(1) });
      p.step([IDLE_INPUT, bot.update(RAGDOLL.step, obs, arena), IDLE_INPUT]);
      travelled += Math.hypot(b.x - last.x, b.z - last.z);
      last = b;
    }
    return { alive: !p.players[1].eliminated, travelled };
  } finally {
    p.dispose();
  }
}

test("a lone bot retreats from risky starts (alley, deck edge, front gap) and keeps off lethal edges", () => {
  for (const [seed, start] of [
    [1, map.spawns[1]],
    [7, { x: -6.3, y: 1, z: -5 }],
    [42, { x: 6.3, y: 1.9, z: -4.6 }],
    [99, { x: 0, y: 1, z: 3.8 }],
  ] as const) {
    const r = botRun(seed, 40, start);
    assert.ok(r.alive, `seed ${seed} bot fell`);
    assert.ok(r.travelled > 6, `seed ${seed} bot barely moved (${r.travelled.toFixed(1)} m)`);
  }
});

test("human + two bots on the rooftop: bots engage, rounds resolve and reset to rooftop spawns", () => {
  let resolved = 0,
    punches = 0,
    grabs = 0;
  const reasons: (string | null)[] = [];
  for (const seed of [3, 11, 23]) {
    let s = seed;
    const random = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const sim = new LocalRoundSimulation(random, undefined, map);
    try {
      let finished = false;
      for (let i = 0; i < 60 * 70 && !finished; i++) finished = sim.step(IDLE_INPUT) === "finished";
      reasons.push(sim.round.reason);
      if (finished && sim.round.reason !== "timeout") resolved++;
      punches += sim.combat.stats.punches;
      grabs += sim.combat.stats.lifts + sim.combat.stats.releases;
      for (let i = 0; i < 60 * 5; i++) if (sim.step(IDLE_INPUT) === "reset") break;
      assert.equal(sim.round.phase, "countdown");
      for (const c of sim.physics.players) {
        const b = c.body.translation(),
          spawn = map.spawns[c.id];
        assert.ok(Math.hypot(b.x - spawn.x, b.z - spawn.z) < 0.05 && !c.eliminated);
      }
    } finally {
      sim.dispose();
    }
  }
  console.log(JSON.stringify({ rooftopBotRounds: { reasons, punches, grabs } }));
  assert.ok(punches > 10, `bots punched ${punches} times`);
  assert.ok(resolved >= 2, `only ${resolved}/3 rounds ended by elimination: ${reasons}`);
});

// ─── Prediction over rooftop terrain ────────────────────────────────────────

test("prediction over stairs, deck drop and curb stays within soft-correction bounds at 100 ms RTT", () => {
  const server = new OnlineRoundSimulation(),
    local = new LocalPrediction(0),
    remote = new SnapshotBuffer(),
    box = new InputMailbox();
  try {
    server.start([0, 1]);
    for (let i = 0; i < 240; i++) server.step([]);
    restore(server.physics.players[0], { x: 0.3, y: 1.2, z: -5.1 }, facing(1, 0));
    for (let i = 0; i < 60; i++) server.step([]);
    const snap = (): GameSnapshot => ({
      ...server.snapshot([box.processedSeq, -1, -1]),
      prediction: capturePredictionState(server.physics.players[0], server.combat.players[0]),
    });
    remote.push(snap(), 0);
    local.reconcile(remote.latest!, 0);
    const rtt = 100,
      stepMs = 1000 / 60,
      up: { due: number; p: InputPacket }[] = [],
      down: { due: number; s: GameSnapshot }[] = [];
    let seq = 0;
    // Up the stairs, across the deck, drop off its front, around a condenser with a jump, stop short of the curb.
    const plan = (t: number): Partial<InputPacket> =>
      t < 0.9 ? { moveX: 1 } : t < 1.7 ? { moveZ: 1 } : t < 1.9 ? {} : t < 3.1 ? { moveX: -0.5, moveZ: 0.86, jumpPressed: t > 2.5 && t < 2.54 } : {};
    for (let i = 0; i < 60 * 6; i++) {
      const now = i * stepMs;
      while (down[0]?.due <= now + 1e-6) {
        remote.push(down.shift()!.s, now);
        local.reconcile(remote.latest!, now);
      }
      if (i % 2 === 0) {
        const p: InputPacket = { seq: ++seq, round: 1, moveX: 0, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false, ...plan(i / 60) };
        up.push({ due: now + rtt / 2, p });
        local.advance(p, 2, now);
      }
      while (up[0]?.due <= now + 1e-6) box.accept(up.shift()!.p, 1, now);
      server.step([box.read(now)]);
      if (i % 3 === 0) down.push({ due: now + rtt / 2, s: snap() });
      assert.ok(local.rig.valid());
    }
    const m = local.metrics;
    console.log(JSON.stringify({ rooftopPrediction: { reconciliations: m.reconciliations, avg: m.totalError / Math.max(1, m.reconciliations), max: m.maxError, corrections: m.corrections, hard: m.hard } }));
    assert.equal(server.physics.players[0].eliminated, false);
    assert.ok(m.reconciliations > 50);
    assert.equal(m.hard, 0, "no hard corrections on stairs/deck/curb terrain");
    assert.ok(m.maxError < 0.5, `max error ${m.maxError}`);
  } finally {
    local.dispose();
    server.dispose();
  }
});

// ─── Visual layout stays out of gameplay ────────────────────────────────────

test("backdrop, tank and haze are visual only and create no fake landing surfaces", () => {
  const arena = botArena(map);
  assert.ok(HAZE_Y > RAGDOLL.fallY && HAZE_Y < 0, "bodies enter the haze before elimination");
  for (const b of BACKDROP) {
    // Nearest point of the block footprint to every lethal edge must keep the clearance.
    for (const edge of map.lethalEdges)
      for (let t = 0; t <= 1; t += 0.02) {
        const x = edge.from.x + (edge.to.x - edge.from.x) * t,
          z = edge.from.z + (edge.to.z - edge.from.z) * t;
        const gx = Math.max(b.x[0] - x, x - b.x[1], 0),
          gz = Math.max(b.z[0] - z, z - b.z[1], 0);
        assert.ok(Math.hypot(gx, gz) >= BACKDROP_CLEARANCE - 1e-9, `backdrop ${b.x},${b.z} near a lethal edge`);
      }
    assert.ok(nearestLethalEdge(arena, (b.x[0] + b.x[1]) / 2, (b.z[0] + b.z[1]) / 2)!.distance >= BACKDROP_CLEARANCE);
    // Only the skyline behind the safe back wall rises above the haze; everything else is
    // below it and below the elimination height, so it can never read as a place to land.
    if (b.top > HAZE_Y) assert.ok(b.z[1] < ROOF.minZ - 2, `backdrop ${b.x},${b.z} rises above the haze beside a drop`);
    else assert.ok(b.top < RAGDOLL.fallY, `sunk backdrop ${b.x},${b.z} must sit below the elimination height`);
  }
  assert.ok(WATER_TANK.z + WATER_TANK.radius < ROOF.minZ - 2, "tank sits behind the safe wall");
  // Hazard paint marks only open lethal edges (never the safe back or curbs).
  for (const [, , z0, z1, y] of HAZARD_STRIPES) {
    assert.ok(z0 >= ROOF.minZ + 0.4 - 1e-9, "not on the parapet");
    assert.ok(y === 0 || y === 1);
    assert.ok(z1 <= ROOF.maxZ + 1e-9);
  }
});

test("world-UV boxes wind outward and tile by metres", () => {
  const g = new WorldGeometry(2).box([0, 0, 0], [2, 1, 4]).build();
  const pos = g.getAttribute("position"),
    nor = g.getAttribute("normal"),
    idx = g.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const [a, b, c] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    const e1 = [pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a)],
      e2 = [pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a)];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    assert.ok(n[0] * nor.getX(a) + n[1] * nor.getY(a) + n[2] * nor.getZ(a) > 0, "counter-clockwise from outside");
  }
  const uv = g.getAttribute("uv");
  let maxU = 0;
  for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, Math.abs(uv.getX(i)));
  assert.equal(maxU, 2, "4 m face spans two 2 m tiles");
  g.dispose();
});
