import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { initializePhysics, IDLE_INPUT } from "./physics";
import type { PlayerId } from "./players";
import { restore } from "./ragdoll/character";
import { SHAPES } from "./ragdoll/config";
import { retire } from "./layers/game";
import { PropHuntGame, type PropHuntEvent } from "./prophunt/game";
import { seekerIntent } from "./prophunt/controls";
import { SeekerBot, SEEKER_SENSE, layoutNav } from "./prophunt/bots";
import { activeView, FIRST_PERSON_HIDDEN, PROP_CAMERA, propCameraBlockers, propCameraPose, propFirstPersonPose, toggledView, VIEW_KEY } from "./prophunt/propCamera";
import { castBlockers, insideBlockers } from "./arenas/barnCamera";
import { SENSE_AUDIO } from "./prophunt/whistle";
import { PROP_HUNT_MAP, SEEKER_SPAWN, surfaceBelow, type PropRole } from "../../../shared/party-lab/maps/propHunt";
import { layoutOf, REFERENCE_LAYOUT } from "../../../shared/party-lab/maps/propHuntLayout";
import { PROP_FAMILIES, shapeHeight, type PropFamilyId } from "../../../shared/party-lab/maps/propHuntProps";
import type { ArenaCollider } from "../../../shared/party-lab/maps/types";
import { PROP_HUNT, PROP_TICKS } from "../../../shared/party-lab/simulation/prophunt/config";
import { ProximitySense, segmentBlocked, SENSE_BLOCKING, senses } from "../../../shared/party-lab/simulation/prophunt/proximity";
import { GAME_MODES } from "../../../shared/party-lab/modes";
import { NET } from "../../../shared/party-lab/network/protocol";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";

/**
 * Saklambaç's seeker pass: the optional first-person camera (the same shot as the shoulder
 * camera), the hunch (a hider close by for a moment: one generic pulse) and the bot's fair use
 * of it. The periodic whistle is in prophunt.test.ts.
 */
before(() => initializePhysics());

const IDLE: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const SEEKER_FIRST: PropRole[] = ["seeker", "hider", "hider"];
const P = PROP_HUNT.proximity;

function game(layout = REFERENCE_LAYOUT, phase: "hiding" | "search" = "hiding") {
  const g = new PropHuntGame(silentFeedback, { roles: SEEKER_FIRST, layout });
  while (g.round.phase !== phase) g.step(IDLE);
  return g;
}
const press = (id: PlayerId, extra: Partial<MovementInput> = {}) => IDLE.map((input, k) => (k === id ? { ...input, ...extra } : input));
function steps(g: PropHuntGame, seconds: number, inputs: () => MovementInput[] = () => IDLE) {
  const events: PropHuntEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    g.step(inputs());
    events.push(...g.events);
  }
  return events;
}
/** A body standing at (x, z) on the floor at or below `top` (default: the highest one there). */
function place(g: PropHuntGame, id: PlayerId, x: number, z: number, yaw = 0, top = Infinity) {
  restore(g.physics.players[id], { x, y: surfaceBelow(x, z, top) + 0.9, z }, yaw);
}
/** A hider disguised as `family` at (x, z) on the floor at or below `top` (as a transform would leave it). */
function wearAt(g: PropHuntGame, id: PlayerId, family: PropFamilyId, x: number, z: number, top = Infinity, yaw = 0) {
  const at = g.disguises.place(id, family, x, z, surfaceBelow(x, z, top), yaw);
  assert.ok(at, `room for a ${family} at (${x}, ${z})`);
  retire(g.physics.players[id]);
  return g.disguises.wear(id, family, at!, yaw);
}
const nears = (events: PropHuntEvent[]) => events.filter((e) => e.type === "near");
const pelvis = (g: PropHuntGame, id: PlayerId) => g.physics.players[id].body.translation();
const top = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y + c.halfHeight : c.center.y + c.half.y);
const bottom = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y);
function gap(c: ArenaCollider, x: number, z: number) {
  if (c.shape === "cylinder") return Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius);
  return Math.hypot(Math.max(0, Math.abs(x - c.center.x) - c.half.x), Math.max(0, Math.abs(z - c.center.z) - c.half.z));
}
/** Room for a standing body at (x, z) on `floor`. */
function roomAt(x: number, z: number, floor: number, decoys: readonly ArenaCollider[] = REFERENCE_LAYOUT.colliders) {
  if (Math.abs(x) > 10.4 || Math.abs(z) > 10.4 || Math.abs(surfaceBelow(x, z, floor + 0.3) - floor) > 0.01) return false;
  return [...PROP_HUNT_MAP.colliders, ...decoys].every((c) => c.role === "floor" || top(c) <= floor + 0.05 || bottom(c) >= floor + 2 || gap(c, x, z) >= 0.5);
}

// ─── The hunch ──────────────────────────────────────────────────────────────

test("hunch: 5.5 m, 0.9 s dwell; leave 6.5 m for 1.25 s to rearm", () => {
  assert.deepEqual({ ...P }, { radius: 5.5, vertical: 1.5, dwell: 0.9, rearmRadius: 6.5, outsideDwell: 1.25 });
  assert.equal(PROP_TICKS.proximityDwell, 54);
  assert.equal(PROP_TICKS.proximityOutsideDwell, 75);
  // Architecture stops it; furniture, rails, posts, steps, the stair and every prop do not.
  assert.deepEqual([...SENSE_BLOCKING].sort(), ["boundary", "deck", "floor", "glass", "loft", "roof", "tent", "wall", "woodpile"]);
});

test("hunch geometry: the same space only — a wall, a window, the loft floor or a tent between them stops it; a doorway, the porch rail, furniture and props do not; beyond 5.5 m or 1.5 m of height, never", () => {
  const at = (x: number, feet: number, z: number) => ({ x, y: feet + 0.78, z });
  const prop = (x: number, feet: number, z: number, h = 0.9) => ({ x, z, feet, middle: feet + h / 2, top: feet + h * 0.85 });
  const body = (x: number, feet: number, z: number) => ({ x, z, feet, middle: feet + 1.18, top: feet + 1.65 });
  const cases: [string, boolean, boolean][] = [
    ["great room, 2.5 m", senses(at(-8, 0.45, -6), prop(-5.5, 0.45, -6)), true],
    ["the lodge's east wall", senses(at(3.0, 0, -7), prop(0.8, 0.45, -7)), false],
    ["the kitchen's east window (glass)", senses(at(3.0, 0, -3.4), prop(0.8, 0.45, -3.4)), false],
    ["through the side door", senses(at(3.0, 0, -5.2), prop(0.5, 0.45, -5.2)), true],
    ["porch → great room through the south wall", senses(at(-9.4, 0.45, -1.8), prop(-9.4, 0.45, -4)), false],
    ["porch → dining room through its window", senses(at(-4.3, 0.45, -1.7), prop(-4.3, 0.45, -3.4, 1.8)), false],
    ["porch → lodge through the front door", senses(at(-6.5, 0.45, -1.5), prop(-6.5, 0.45, -4.5)), true],
    ["the shed's south wall", senses(at(7.0, 0, -4.5), prop(7.0, 0.15, -7)), false],
    ["the shed's door", senses(at(8.7, 0, -4.0), prop(8.7, 0.15, -7)), true],
    ["kitchen below, loft above (same x, z)", senses(at(-1, 0.45, -6), prop(-1, 3.65, -6)), false],
    ["loft above, kitchen below", senses(at(-1, 3.65, -6), body(-0.5, 0.45, -7)), false],
    ["halfway up the stair vs the loft", senses(at(-5, 2.0, -9.8), prop(-3, 3.65, -9.8)), false],
    ["behind a tent", senses(at(-7.5, 0, 4), body(-10.5, 0, 4)), false],
    ["over the porch rail (ground → porch)", senses(at(-4, 0, 1.6), prop(-4, 0.45, -0.6)), true],
    ["across the fire pit", senses(at(-1, 0, 2.2), prop(-1, 0, 5.4, 0.45)), true],
    ["under the pavilion's roof", senses(at(5, 0, 5), body(7.5, 0, 5)), true],
    ["yard, 3.4 m", senses(at(3, 0, 0), prop(6.4, 0, 0)), true],
    ["yard, 5.4 m", senses(at(3, 0, 0), prop(8.4, 0, 0)), true],
    ["yard, 5.6 m", senses(at(3, 0, 0), prop(8.6, 0, 0)), false],
    ["the woodpile's top from the yard (1.2 m up)", senses(at(5.7, 0, -5.8), prop(5.8, 1.2, -8)), true],
    ["the lean-to roof from the yard (1.8 m up and more)", senses(at(3.5, 0, -6.2), prop(3.5, 2.2, -8.5)), false],
  ];
  for (const [name, got, want] of cases) assert.equal(got, want, name);
  // Clutter never stops it: a line through the dining table, a chair and the couch is clear; the same line through a wall is not.
  assert.ok(!segmentBlocked({ x: -8.5, y: 1.6, z: -6.2 }, { x: -2.8, y: 1.0, z: -6.2 }), "furniture and chairs are no blockers");
  assert.ok(segmentBlocked({ x: 3.0, y: 1.6, z: -7.0 }, { x: 0.8, y: 1.2, z: -7.0 }), "a wall is");
});

test("hunch: farther approach pulses once, stays silent for 12 s, must leave all hiders to rearm", () => {
  const g = game();
  wearAt(g, 1, "crate", 4.3, -4.8);
  place(g, 2, -8, 7, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  place(g, 0, 4.3, 1.4, Math.PI);
  assert.equal(nears(steps(g, 2)).length, 0);
  place(g, 0, 4.3, 0.4, Math.PI);
  assert.equal(nears(steps(g, 0.7)).length, 0, "dwell required at 5.2 m");
  assert.equal(nears(steps(g, 0.4)).length, 1);
  assert.equal(nears(steps(g, 12)).length, 0, "standing still never repeats");
  place(g, 0, 4.3, 1.4, Math.PI);
  steps(g, 2);
  assert.equal(g.sense.armed, false, "6.2 m is still inside the rearm radius");
  place(g, 0, 4.3, 2.4, Math.PI);
  steps(g, 0.5);
  place(g, 0, 4.3, 0.4, Math.PI);
  assert.equal(nears(steps(g, 2)).length, 0, "brief exit cannot rearm");
  place(g, 0, 4.3, 2.4, Math.PI);
  steps(g, 1.4);
  assert.equal(g.sense.armed, true);
  place(g, 0, 4.3, 0.4, Math.PI);
  assert.equal(nears(steps(g, 1.2)).length, 1);
  g.dispose();
});

test("hunch latch: continuous dwell, outside dwell, visibility changes and boundary jitter", () => {
  const sense = new ProximitySense();
  const tick = (close: boolean, outside = false) => sense.step(() => close, () => outside);
  for (let i = 0; i < 53; i++) assert.equal(tick(true), false);
  tick(false);
  for (let i = 0; i < 53; i++) assert.equal(tick(true), false);
  assert.equal(tick(true), true);
  for (let i = 0; i < 900; i++) assert.equal(tick(i % 2 === 0), false, "walls cannot rearm");
  for (let i = 0; i < 74; i++) tick(false, true);
  tick(false, false);
  for (let i = 0; i < 74; i++) tick(false, true);
  assert.equal(sense.armed, false);
  tick(false, true);
  assert.equal(sense.armed, true);
  for (let i = 0; i < 53; i++) assert.equal(tick(true), false);
  assert.equal(tick(true), true);
});

test("hunch: a hider's height, a floor, a wall or a window between them stops it (no pulse in 6 s); a crowd of furniture and props between them does not", () => {
  const quiet = (setup: (g: PropHuntGame) => void, seconds = 6) => {
    const g = game();
    setup(g);
    while (g.round.phase !== "search") g.step(IDLE);
    const events = steps(g, seconds);
    const n = nears(events).length,
      close = g.hiderNear();
    g.dispose();
    return { n, close };
  };
  const far = (g: PropHuntGame) => place(g, 2, -1.0, 8.5, 0);
  // The loft over the kitchen: the hider upstairs, the seeker right under it.
  let r = quiet((g) => {
    wearAt(g, 1, "crate", -1.2, -6.0);
    far(g);
    place(g, 0, -1.2, -6.2, 0, 1);
  });
  assert.deepEqual(r, { n: 0, close: false }, "loft above");
  // The shed: the hider inside, the seeker outside its south wall, 3 m away.
  r = quiet((g) => {
    wearAt(g, 1, "crate", 7.3, -7.2);
    far(g);
    place(g, 0, 7.0, -4.4, 0);
  });
  assert.deepEqual(r, { n: 0, close: false }, "shed wall");
  // The dining window: the hider inside, the seeker on the porch outside the glass.
  r = quiet((g) => {
    wearAt(g, 1, "chair", -4.3, -3.4, 1);
    far(g);
    place(g, 0, -4.3, -1.6, Math.PI);
  });
  assert.deepEqual(r, { n: 0, close: false }, "window");
  // The same shed through its open door: a pulse.
  r = quiet((g) => {
    wearAt(g, 1, "crate", 8.7, -7.3);
    far(g);
    place(g, 0, 8.7, -4.3, Math.PI);
  }, 2);
  assert.ok(r.n === 1 && r.close, "through the shed's door");
  // Among the dining chairs, across the table and the chairs from 3.2 m: a pulse.
  r = quiet((g) => {
    wearAt(g, 1, "chair", -2.9, -6.3, 1);
    far(g);
    place(g, 0, -6.1, -6.3, Math.PI / 2, 1);
  }, 2);
  assert.ok(r.n === 1 && r.close, "across the dining table");
});

test("hunch: it tells nothing but 'someone is close' — the event has no hider, place, direction or distance; two hiders close give one pulse; a found hider gives none; the next round starts over", () => {
  const g = game();
  wearAt(g, 1, "crate", 4.3, -4.8);
  place(g, 2, 5.6, -2.6, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  place(g, 0, 4.6, -2.0, Math.PI);
  assert.ok(g.round.hidden.every((id) => senses(pelvis(g, 0), g.senseTarget(id))), "both hiders close");
  let events = steps(g, 5.5);
  const pulses = nears(events);
  assert.equal(pulses.length, 1, "one pulse for two hiders");
  assert.deepEqual(Object.keys(pulses[0]).sort(), ["seeker", "type"]);
  assert.equal(pulses[0].type === "near" && pulses[0].seeker, 0);
  // Both found (one shot each, point blank): no more pulses, however close the seeker stays.
  for (const id of [1, 2] as PlayerId[]) {
    const t = g.senseTarget(id),
      p = pelvis(g, 0),
      eye = { x: p.x, y: p.y + PROP_HUNT.aim.pivotHeight, z: p.z },
      yaw = Math.atan2(t.x - eye.x, t.z - eye.z),
      pitch = -Math.atan2(t.middle - eye.y, Math.hypot(t.x - eye.x, t.z - eye.z)),
      input = { ...IDLE_INPUT, facing: yaw, aimPitch: pitch, aimEye: { x: 0, y: PROP_HUNT.aim.pivotHeight, z: 0 } };
    steps(g, 0.7, () => press(0, input));
    if (g.round.phase === "search") g.step(press(0, { ...input, attack: true }));
  }
  assert.equal(g.round.outcome, "seeker", "both found");
  events = steps(g, 2);
  assert.equal(nears(events).length, 0);
  // The next round: nothing carried over.
  while ((g.round.phase as string) !== "countdown") g.step(IDLE);
  assert.deepEqual({ pulses: g.sense.pulses, dwell: g.sense.dwell, armed: g.sense.armed, outside: g.sense.outside }, { pulses: 0, dwell: 0, armed: true, outside: 0 });
  g.dispose();
  // One hider found, the other far: the found one never pulses even with the seeker on its spot.
  const h = game();
  wearAt(h, 1, "crate", 4.3, -4.8);
  place(h, 2, -1.0, 8.5, 0);
  while (h.round.phase !== "search") h.step(IDLE);
  const spot = h.senseTarget(1);
  retire(h.physics.players[1]);
  h.disguises.remove(1);
  h.round.alive[1] = false;
  place(h, 0, spot.x, spot.z + 1.6, Math.PI);
  assert.equal(nears(steps(h, 3)).length, 0);
  h.dispose();
});

test("hunch presentation: a fixed line and an even glow, a centred heartbeat — no name, prop, arrow, compass, distance or outline; nothing marks the prop", () => {
  const hud = readFileSync(new URL("./prophunt/PropHuntHud.tsx", import.meta.url), "utf8");
  const line = hud.match(/hud\.current\.sense = element\)\}>\s*([^<]+?)\s*</)?.[1];
  assert.equal(line, "Yakınlarda biri var...");
  const playground = readFileSync(new URL("./prophunt/PropHuntPlayground.tsx", import.meta.url), "utf8");
  const handler = playground.slice(playground.indexOf('e.type === "near"'), playground.indexOf("function hunch()"));
  // The handler reads nothing about hiders: no ids, positions, props or distances.
  for (const word of ["disguiseOf", "senseTarget", "reveal", "decoy", "e.at", "distance", "setTarget", "setReveal", "textContent"]) assert.ok(!handler.includes(word), `the hunch handler uses ${word}`);
  const css = readFileSync(new URL("../party-lab.css", import.meta.url), "utf8");
  const glow = css.match(/\.pl-prop-sense-glow \{([^}]*)\}/)?.[1] ?? "";
  assert.match(glow, /inset: 0/);
  assert.match(glow, /box-shadow: inset 0 0 \d+px/, "the same glow on every edge");
  // The heartbeat is centred and flat: no panning, no distance.
  assert.equal(SENSE_AUDIO.spatial, 0);
  assert.equal(SENSE_AUDIO.rolloff, 0);
  // Nothing in the 3D visuals knows about it.
  assert.ok(!/"near"|sense|hunch/i.test(readFileSync(new URL("./prophunt/visuals.ts", import.meta.url), "utf8")));
});

test("hunch (bot): the seeker bot gets the pulse and nothing else — props it saw around where it stands become suspects and it looks round; where the hiders really are changes nothing", () => {
  const run = (hider: { x: number; z: number }, pulse = true) => {
    const g = game();
    wearAt(g, 1, "crate", hider.x, hider.z);
    place(g, 2, -1.0, 8.5, 0);
    while (g.round.phase !== "search") g.step(IDLE);
    place(g, 0, 4.4, -1.4, Math.PI);
    const bot = new SeekerBot(0, mulberry32(3));
    // Looking over the yard for 2 s (held in place).
    for (let t = 0; t < 120; t++) g.step([{ ...bot.update(g), x: 0, z: 0, attack: false }, IDLE_INPUT, IDLE_INPUT]);
    const before = new Map([...bot.memory].map(([k, m]) => [k, m.suspicion]));
    // The pulse, as the game would send it (the bot never asks the game who or where).
    g.events.length = 0;
    if (pulse) g.events.push({ type: "near", seeker: 0 });
    bot.update(g);
    const p = pelvis(g, 0);
    const changed = [...bot.memory].map(([k, m]) => ({ key: k, near: Math.hypot(m.x - p.x, m.z - p.z) <= P.radius + SEEKER_SENSE.hunchSlack && Math.abs(m.y - (p.y - 0.78)) <= P.vertical, delta: m.suspicion - (before.get(k) ?? 0), family: m.family }));
    const mode = bot.mode;
    g.dispose();
    return { changed, mode };
  };
  const a = run({ x: 4.3, z: -4.8 }),
    b = run({ x: 9.0, z: -2.0 });
  assert.ok(a.changed.some((c) => c.near && c.delta >= SEEKER_SENSE.hunchNudge - 1e-9), "props it saw nearby are suspects now");
  for (const c of a.changed) if (!c.near) assert.ok(c.delta < 0.2, `${c.key} (far) untouched`);
  assert.ok(["look", "inspect", "approach", "aim"].includes(a.mode), `it reacts where it stands (${a.mode})`);
  // Without the pulse: no jump in suspicion anywhere.
  const control = run({ x: 4.3, z: -4.8 }, false);
  for (const c of control.changed) assert.ok(c.delta < 0.2, `${c.key} +${c.delta.toFixed(2)} without a pulse`);
  // The hiders elsewhere: the bot's reaction to a pulse is the same (only its own place and what it saw count).
  const nudged = (r: typeof a) =>
    r.changed
      .filter((c) => c.delta >= SEEKER_SENSE.hunchNudge - 1e-9 && c.family !== "crate")
      .map((c) => c.key)
      .sort();
  assert.deepEqual(nudged(a), nudged(b));
});

test("hunch (bot source): the seeker bot never asks the game who is close — no hiderNear(), senseTarget() or proximity geometry", () => {
  const source = readFileSync(new URL("./prophunt/bots.ts", import.meta.url), "utf8");
  const seeker = source.slice(source.indexOf("export class SeekerBot"));
  for (const word of ["hiderNear", "senseTarget", "senses(", "segmentBlocked", "game.sense"]) assert.ok(!seeker.includes(word), word);
});

// ─── The seeker's first-person camera ───────────────────────────────────────

test("first person: an optional seeker view — the shoulder camera by default, V swaps (and back); a hider never gets it; eye height, FOV 68–72°, room to look up at the loft", () => {
  assert.equal(VIEW_KEY, "KeyV");
  assert.equal(activeView("third", "seeker"), "third");
  assert.equal(toggledView("third", "seeker"), "first");
  assert.equal(toggledView("first", "seeker"), "third");
  assert.equal(activeView("first", "seeker"), "first");
  assert.equal(toggledView("third", "hider"), "third");
  assert.equal(activeView("first", "hider"), "third", "a hider's camera is always third person");
  const f = PROP_CAMERA.firstPerson;
  assert.ok(f.fov >= 68 && f.fov <= 72, `FOV ${f.fov}`);
  // The eye: at the head, a little ahead of the body's axis (the head's middle is 0.78 + 0.87 above the feet).
  assert.ok(Math.abs(f.eye - (0.78 + SHAPES.head.y)) < 0.1, `eye ${f.eye} m`);
  assert.ok(f.minPitch <= -Math.PI / 4 && f.maxPitch >= Math.PI / 3 && f.maxPitch < 1.2, "look up at the loft, down at the floor (within the shot's ±1.2 rad)");
  // The shoulder camera is unchanged.
  assert.equal(PROP_CAMERA.seeker.boom, 4.8);
  assert.equal(PROP_CAMERA.seeker.fov, 60);
});

test("first person: the eye never sits in a wall, a window, a roof or a prop from any standing spot and view; it stays at eye height (pulled in rarely); no own-head clipping — the eye is inside the head, which is not drawn, and every part still drawn is clear of the near plane", () => {
  const blockers = propCameraBlockers(REFERENCE_LAYOUT.colliders),
    nav = layoutNav(REFERENCE_LAYOUT),
    reach = nav.field(nav.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z)),
    f = PROP_CAMERA.firstPerson;
  let total = 0,
    pulled = 0;
  for (const n of nav.nodes.filter((node, k) => k % 2 === 0 && !nav.blocked[node.id] && Number.isFinite(reach.dist[node.id]))) {
    const feet = n.y,
      eye = { x: n.x, y: feet + f.eye, z: n.z },
      chest = { x: n.x, y: feet + 0.78 + SHAPES.torso.y, z: n.z };
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2,
        pose = propFirstPersonPose(blockers, eye, chest, yaw, 0.2);
      assert.ok(!insideBlockers(blockers, pose.position, 0.05), `eye inside geometry at (${n.x}, ${n.y}, ${n.z}) yaw ${k}`);
      const d = Math.hypot(pose.position.x - chest.x, pose.position.y - chest.y, pose.position.z - chest.z);
      assert.ok(castBlockers(blockers, chest, { x: (pose.position.x - chest.x) / d, y: (pose.position.y - chest.y) / d, z: (pose.position.z - chest.z) / d }, d) >= d - 1e-6, "nothing between the chest and the eye");
      total++;
      if (Math.abs(pose.position.y - eye.y) > 0.05 || Math.hypot(pose.position.x - n.x, pose.position.z - n.z) < f.forward - 0.05) pulled++;
    }
  }
  assert.ok(total > 1000, `${total} samples`);
  assert.ok(pulled / total < 0.03, `pulled in at ${Math.round((1000 * pulled) / total) / 10}% of samples`);
  // Own body in first person, standing (body frame: feet at 0, the pelvis 0.78 up, facing +z).
  const eye = { x: 0, y: f.eye, z: f.forward },
    near = 0.1;
  const partDistance = (name: keyof typeof SHAPES) => {
    const s = SHAPES[name],
      c = { x: s.x, y: 0.78 + s.y, z: 0 },
      dy = Math.max(0, Math.abs(eye.y - c.y) - s.half);
    return Math.hypot(eye.x - c.x, dy, eye.z - c.z) - s.radius;
  };
  assert.ok(partDistance("head") < 0, "the eye is inside the head (so the head is not drawn)");
  assert.ok(partDistance("torso") < near + 0.05, "the chest sits right under the eye (so it is not drawn)");
  assert.ok(FIRST_PERSON_HIDDEN.includes("head") && FIRST_PERSON_HIDDEN.includes("torso"));
  for (const name of Object.keys(SHAPES) as (keyof typeof SHAPES)[])
    if (!(FIRST_PERSON_HIDDEN as readonly string[]).includes(name)) assert.ok(partDistance(name) > near + 0.2, `${name} drawn ${partDistance(name).toFixed(2)} m from the eye`);
  // The third-person camera is still never inside geometry either (spot check).
  const pose = propCameraPose(blockers, PROP_CAMERA.seeker, PROP_CAMERA.seeker.boom, { x: -1, y: 1.78, z: 3 }, Math.PI, PROP_CAMERA.seeker.restPitch, { boom: null }, 1 / 60);
  assert.ok(!insideBlockers(blockers, pose.position, 0.02));
});

/** A crate in the open field (between the yard and the pavilion) on top of the reference layout: cover for the fairness tests. */
const CRATE = { x: 5.5, z: 1.6 };
const COVER = layoutOf([...REFERENCE_LAYOUT.decoys, { family: "crate", x: CRATE.x, y: 0, z: CRATE.z, turns: 0, zone: "border" }], null);
const CRATE_INDEX = COVER.decoys.length - 1;
/** The first-person eye of the seeker standing still (the camera's smoothing settled), as the playground computes it. */
function fpsEye(g: PropHuntGame, yaw: number, pitch: number) {
  const p = pelvis(g, g.seeker),
    torso = g.physics.players[g.seeker].parts.torso.body.translation();
  return propFirstPersonPose(propCameraBlockers(g.layout.colliders), { x: p.x, y: p.y - 0.78 + PROP_CAMERA.firstPerson.eye, z: p.z }, torso, yaw, pitch).position;
}
/** Yaw and pitch putting a camera at `eye` on `target`, as the seeker's intent (the aim-line point relative to the pelvis). */
function lookFrom(g: PropHuntGame, eye: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): MovementInput {
  const p = pelvis(g, g.seeker),
    yaw = Math.atan2(target.x - eye.x, target.z - eye.z),
    pitch = -Math.atan2(target.y - eye.y, Math.hypot(target.x - eye.x, target.z - eye.z));
  const raw = { x: 0, z: 0, jump: false, punch: false, grab: false, lift: false };
  return seekerIntent(raw, yaw, pitch, { x: eye.x - p.x, y: eye.y - p.y, z: eye.z - p.z });
}
/** The shoulder camera's aim-line point for a yaw and pitch (the playground's: the camera line's nearest point to the shoulder). */
function shoulderEye(g: PropHuntGame, yaw: number, pitch: number) {
  const p = pelvis(g, g.seeker),
    pivot = { x: p.x, y: p.y + PROP_CAMERA.seeker.pivotHeight, z: p.z },
    pose = propCameraPose(propCameraBlockers(g.layout.colliders), PROP_CAMERA.seeker, PROP_CAMERA.seeker.boom, pivot, yaw, pitch, { boom: null }, 1 / 60),
    t = Math.max(0, (pose.shoulder.x - pose.position.x) * pose.look.x + (pose.shoulder.y - pose.position.y) * pose.look.y + (pose.shoulder.z - pose.position.z) * pose.look.z);
  return { x: pose.position.x + pose.look.x * t, y: pose.position.y + pose.look.y * t, z: pose.position.z + pose.look.z * t };
}
/** Converges the shoulder camera's aim on a world point (its eye moves with the yaw). */
function lookFromShoulder(g: PropHuntGame, target: { x: number; y: number; z: number }): MovementInput {
  const p = pelvis(g, g.seeker);
  let yaw = Math.atan2(target.x - p.x, target.z - p.z),
    pitch = 0;
  for (let k = 0; k < 6; k++) {
    const eye = shoulderEye(g, yaw, pitch);
    yaw = Math.atan2(target.x - eye.x, target.z - eye.z);
    pitch = -Math.atan2(target.y - eye.y, Math.hypot(target.x - eye.x, target.z - eye.z));
  }
  const eye = shoulderEye(g, yaw, pitch);
  return seekerIntent({ x: 0, z: 0, jump: false, punch: false, grab: false, lift: false }, yaw, pitch, { x: eye.x - p.x, y: eye.y - p.y, z: eye.z - p.z });
}
/** The seeker settles at (x, z) facing `input`'s yaw. */
function stand(g: PropHuntGame, x: number, z: number, input: () => MovementInput) {
  place(g, 0, x, z, input().facing ?? 0);
  steps(g, 0.6, () => press(0, { ...input(), attack: false }));
}

test("first person shoots with the same simulation: over a crate the eye sees a hider the body cannot hit — the shot leaves the torso and the crate takes it (red X); the shoulder camera gets the same answer; with a clear line both find it", () => {
  assert.ok(roomAt(CRATE.x, CRATE.z, 0, REFERENCE_LAYOUT.colliders), "open ground for the crate");
  let found: { a: number; b: number } | null = null;
  // A low stump behind the crate; the seeker a step in front of it: find a stance where the eye sees the stump over the crate but the torso's line meets the crate.
  for (const b of [1.4, 1.7, 2.0])
    for (const a of [0.75, 0.85, 0.95, 1.1, 1.25]) {
      const g = game(COVER);
      const worn = wearAt(g, 1, "stump", CRATE.x, CRATE.z - b);
      place(g, 2, -1.0, 8.5, 0);
      while (g.round.phase !== "search") g.step(IDLE);
      const w = worn.body.translation(),
        target = { x: w.x, y: w.y + shapeHeight(PROP_FAMILIES.stump.shape) * 0.7, z: w.z };
      const input = () => lookFrom(g, fpsEye(g, Math.PI, 0.3), target);
      stand(g, CRATE.x, CRATE.z + a, input);
      const aim = g.aim(input()),
        shot = g.cast(aim.origin, aim.direction, PROP_HUNT.seeker.range, 0);
      if (aim.target?.hit === "hider" && shot?.hit === "decoy" && shot.decoy === CRATE_INDEX) {
        found = { a, b };
        const toPoint = Math.hypot(aim.point.x - aim.origin.x, aim.point.y - aim.origin.y, aim.point.z - aim.origin.z);
        assert.ok(shot.distance < toPoint - 0.35, "the crosshair turns into a red X");
        // The torso, not the camera, is where the shot leaves.
        const torso = g.physics.players[0].parts.torso.body.translation();
        assert.ok(Math.hypot(aim.origin.x - torso.x, aim.origin.y - torso.y, aim.origin.z - torso.z) < 1e-6);
        g.step(press(0, { ...input(), attack: true }));
        const e = g.events.find((x) => x.type === "shot");
        assert.ok(e?.type === "shot" && e.hit === "decoy" && e.decoy === CRATE_INDEX, `first person: ${JSON.stringify(e)}`);
        assert.equal(g.round.alive[1], true, "not found");
        // The shoulder camera from the same stance: no find either.
        steps(g, 0.6, () => press(0, lookFromShoulder(g, target)));
        g.step(press(0, { ...lookFromShoulder(g, target), attack: true }));
        const tp = g.events.find((x) => x.type === "shot");
        assert.ok(tp?.type === "shot" && tp.hit !== "hider", `third person: ${JSON.stringify(tp)}`);
        assert.equal(g.round.alive[1], true);
        g.dispose();
        break;
      }
      g.dispose();
    }
  assert.ok(found, "a stance where the eye sees over the crate and the body does not");
  // A clear line (from the side, nothing between): both views find it.
  for (const view of ["first", "third"] as const) {
    const g = game(COVER);
    const worn = wearAt(g, 1, "stump", CRATE.x, CRATE.z - found!.b);
    place(g, 2, -1.0, 8.5, 0);
    while (g.round.phase !== "search") g.step(IDLE);
    const w = worn.body.translation(),
      target = { x: w.x, y: w.y + shapeHeight(PROP_FAMILIES.stump.shape) * 0.5, z: w.z };
    const input = () => (view === "first" ? lookFrom(g, fpsEye(g, -Math.PI / 2, 0.3), target) : lookFromShoulder(g, target));
    stand(g, w.x + 3.0, w.z, input);
    g.step(press(0, { ...input(), attack: true }));
    const e = g.events.find((x) => x.type === "shot");
    assert.ok(e?.type === "shot" && e.hit === "hider" && e.target === 1, `${view}: ${JSON.stringify(e)}`);
    g.dispose();
  }
});

test("first person: a wall stops the shot like before — aimed at a prop behind the lodge's south wall from the porch, the shot ends on the wall; the shot's origin is the torso in both views", () => {
  const g = game(REFERENCE_LAYOUT, "search");
  // The great room's armchair, behind the south wall (not through a window), from the porch.
  const chair = REFERENCE_LAYOUT.decoys[1];
  const target = { x: chair.x, y: chair.y + 0.5, z: chair.z };
  const input = () => lookFrom(g, fpsEye(g, Math.PI, 0.2), target);
  stand(g, -7.9, -1.3, input);
  const aim = g.aim(input());
  assert.equal(aim.target?.hit, "world", "the crosshair is on the wall");
  g.step(press(0, { ...input(), attack: true }));
  const e = g.events.find((x) => x.type === "shot");
  assert.ok(e?.type === "shot" && e.hit === "world" && e.end.z > -2.85, `stopped at the wall: ${JSON.stringify(e)}`);
  const torso = g.physics.players[0].parts.torso.body.translation();
  assert.ok(e?.type === "shot" && Math.hypot(e.origin.x - torso.x, e.origin.z - torso.z) < 0.1, "from the torso");
  g.dispose();
});

test("first person and third person agree on what can be hit: over 100+ aimed shots at props around the camp, the same prop is hit (or not) in both views nearly always, and never does first person hit what the torso's line cannot reach", () => {
  const g = game(REFERENCE_LAYOUT, "search");
  place(g, 1, -1.0, 8.5, 0);
  place(g, 2, 1.0, 8.5, 0);
  const rnd = mulberry32(77),
    decoys = REFERENCE_LAYOUT.decoys;
  let tried = 0,
    agree = 0,
    both = 0;
  for (let k = 0; k < 4000 && tried < 150; k++) {
    const d = decoys[Math.floor(rnd() * decoys.length)],
      a = rnd() * Math.PI * 2,
      r = 2.5 + rnd() * 5,
      x = d.x + Math.cos(a) * r,
      z = d.z + Math.sin(a) * r;
    if (!roomAt(x, z, d.y)) continue;
    const target = { x: d.x, y: d.y + shapeHeight(PROP_FAMILIES[d.family].shape) * 0.5, z: d.z },
      index = decoys.indexOf(d);
    const fp = () => lookFrom(g, fpsEye(g, Math.atan2(d.x - x, d.z - z), 0.2), target);
    place(g, 0, x, z, Math.atan2(d.x - x, d.z - z), d.y + 0.3);
    steps(g, 0.4, () => press(0, fp()));
    const fAim = g.aim(fp()),
      tAim = g.aim(lookFromShoulder(g, target));
    // Only where both crosshairs are on the prop (what a player would shoot at).
    if (fAim.target?.decoy !== index || tAim.target?.decoy !== index) continue;
    tried++;
    const fHit = g.cast(fAim.origin, fAim.direction, PROP_HUNT.seeker.range, 0)?.decoy === index,
      tHit = g.cast(tAim.origin, tAim.direction, PROP_HUNT.seeker.range, 0)?.decoy === index;
    if (fHit === tHit) agree++;
    if (fHit && tHit) both++;
    // The same origin: the torso.
    assert.ok(Math.hypot(fAim.origin.x - tAim.origin.x, fAim.origin.y - tAim.origin.y, fAim.origin.z - tAim.origin.z) < 1e-9);
    // A first-person hit is always along a clear line from the torso.
    if (fHit) assert.ok(!g.cast(fAim.origin, fAim.direction, PROP_HUNT.seeker.range, 0) || g.cast(fAim.origin, fAim.direction, PROP_HUNT.seeker.range, 0)!.decoy === index);
  }
  assert.ok(tried >= 100, `${tried} shots compared`);
  assert.ok(agree / tried >= 0.9, `agreement ${Math.round((100 * agree) / tried)}% (${both} both hit)`);
  g.dispose();
});

// ─── Regression ─────────────────────────────────────────────────────────────

test("regression: online integration — the online modes, the protocol (9) and the seeker's 15 shots, 3 / 15 / 75 s round and whistle-free 10 s are as approved", () => {
  assert.deepEqual([...GAME_MODES], ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "bomb_tag", "prop_hunt"]);
  assert.equal(NET.version, 9);
  assert.equal(PROP_HUNT.seeker.ammo, 15);
  assert.deepEqual({ ...PROP_HUNT.timing }, { countdown: 3, hiding: 15, search: 75, results: 5 });
  assert.ok(!("at" in PROP_HUNT.whistle), "no endgame whistle at 10 s");
});
