import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { initializePhysics } from '../physics';
import { BOXES, BOX_KINDS, CRATE_RAIN as C, FEET, IDLE, seeded, roundWinner, smoothFacing } from './config';
import { CrateRainGame } from './game';
import { CrateBot, type BotSense } from './bots';
import { CrateCamera, CRATE_CAMERA, nextCrateView, viewMovement } from './camera';
import { PerspectiveCamera } from 'three';
import { CrateInput, crateBindings, changeCrateBinding, crateBindingLabel } from './controls';
import { defaultBindings } from '../../input/defaults';
import { warningPose } from './warnings';
import { NET } from '../../../../shared/party-lab/network/protocol';
import { GAME_MODES, MODE_SELECTIONS } from '../../../../shared/party-lab/modes';
before(initializePhysics);
const run = (g: CrateRainGame, seconds: number, input = IDLE) => { for (let i = 0; i < Math.round(seconds / C.step); i++) g.step(input); };
function fixture() {
  const g = new CrateRainGame(2); g.bots = g.spawning = false; g.phase = 'playing';
  g.players[0].body.setTranslation({ x: .7, y: FEET + .025, z: .7 }, true);
  g.players[1].body.setTranslation({ x: -5.6, y: FEET + .025, z: -5.6 }, true); run(g, .2); return g;
}
function emptyRun(g: CrateRainGame) { g.players.forEach(p => p.body.setEnabled(false)); g.bots = false; g.phase = 'playing'; }

test('approved standard size and grid; Crate Rain is registered online', () => {
  assert.equal(C.id, 'crate_rain'); assert.equal(C.rounds, 3); assert.equal(C.countdown, 3); assert.equal(C.maxRoundTime, 20); assert.equal(NET.version, 14);
  assert.ok(GAME_MODES.includes("crate_rain")); assert.equal(MODE_SELECTIONS.length, GAME_MODES.length + 2); // + Mixed + Tahta Oyunu assert.ok(MODE_SELECTIONS.includes(C.id));
  for (const kind of BOX_KINDS) assert.deepEqual(BOXES[kind].size, [1.4, 1.4, 1.4]);
  const g = fixture(); assert.equal(g.cells.length, 100);
  for (const kind of BOX_KINDS) { const cell = g.cells[BOX_KINDS.indexOf(kind)]; const c = g.addCrate(kind, cell.x, .7, cell.z)!; const h = c.collider.halfExtents()!; assert.ok(Math.abs(h.x - .7) < 1e-6); assert.equal(h.x, h.y); assert.equal(h.y, h.z); assert.ok(c.body.isFixed()); }
  g.dispose(); assert.throws(() => new CrateRainGame(8 as 2));
});
test('3 second countdown ignores movement and never pre-fills the court', () => {
  const g = new CrateRainGame(2), z = g.players[0].body.translation().z; g.bots = false;
  run(g, 2.99, { ...IDLE, z: 1 }); assert.equal(g.phase, 'countdown'); assert.equal(g.crates.length, 0); assert.equal(g.players[0].body.translation().z, z);
  run(g, .02); assert.equal(g.phase, 'playing'); assert.ok(g.warnings.length); assert.ok(g.crates.every(c => c.body.isKinematic() && c.collider.isSensor())); g.dispose();
});
test('controlled falling body becomes fixed in place, never wakes, slides or tips', () => {
  const g = fixture(), c = g.addCrate('olive', -2.1, 9.7, 2.1)!;
  assert.ok(c.body.isKinematic()); run(g, 1.2); assert.ok(c.body.isFixed()); assert.equal(c.collider.isSensor(), false);
  const at = c.body.translation(), rot = c.body.rotation();
  g.warn('cedar', -2.1, 2.1); run(g, 1.5); run(g, 2, { ...IDLE, x: -1 });
  assert.deepEqual(c.body.translation(), at); assert.deepEqual(c.body.rotation(), rot); assert.ok(g.crates.every(c => c.body.isFixed()));
  assert.equal(g.stats().kinematic, 0); assert.equal(g.stats().sleeping, 0); assert.equal(g.coverage().maxLayers, 2); g.dispose();
});
test('reservations prevent duplicate falling targets; stack rests exactly on static support', () => {
  const g = fixture();
  for (let level = 0; level < 4; level++) {
    const w = g.warn('cedar', -2.1, 2.1, .65)!; assert.equal(w.y, level * 1.4); assert.equal(g.warn('olive', -2.1, 2.1), null);
    run(g, .7); const c = g.crates[g.crates.length - 1]!; assert.ok(c.body.isFixed()); assert.ok(Math.abs(c.body.translation().y - (level * 1.4 + .7)) < 1e-6);
    assert.equal(g.surface(-2.1, 2.1).y, (level + 1) * 1.4);
  }
  assert.equal(g.invalidBodies, 0); g.dispose();
});
test('swept falling cube kills at very high speeds without tunneling; adjacent miss stays safe', () => {
  for (const duration of [.95, .65, C.step]) {
    const g = fixture(); g.warn('cedar', .7, .7, duration); run(g, duration + .1);
    assert.equal(g.players[0].reason, 'impact'); assert.equal(g.winner, 1); assert.ok(g.impacts[0].lethal); assert.equal(g.tunneling, 0); g.dispose();
  }
  const g = fixture(); g.warn('cedar', 2.1, .7, .65); run(g, .8); assert.ok(g.players[0].alive); g.dispose();
});
test('simultaneous falling contacts yield a deterministic draw', () => {
  const g = fixture(); g.players[1].body.setTranslation({ x: -2.1, y: FEET + .025, z: .7 }, true); run(g, .1);
  g.warn('cedar', .7, .7, .65); g.warn('cedar', -2.1, .7, .65); run(g, .8);
  assert.deepEqual(g.players.map(p => p.alive), [false, false]); assert.equal(g.winner, -1); assert.deepEqual(g.wins, [0, 0]); g.dispose();
});
test('motion of the player is swept too, including a capsule crossing a falling face in one tick', () => {
  const g = fixture(), p = g.players[0]; p.body.setTranslation({ x: -1, y: FEET + .025, z: .7 }, true);
  p.body.setLinvel({ x: 300, y: 0, z: 0 }, true); g.warn('cedar', .7, .7, C.step); g.step();
  assert.equal(p.reason, 'impact'); g.dispose();
});
test('coverage is repeatable, base-first, and full by 20 seconds in all supported arena sizes', () => {
  for (const size of [12.6, 14, 15.4]) for (const seed of [17, 71, 193]) {
    const g = new CrateRainGame(3, seed, size, Math.round(size / 1.4) ** 2 + 6); emptyRun(g);
    let seenStack = false;
    for (let tick = 0; tick < 2400; tick++) {
      g.step(); const coverage = g.coverage();
      if (coverage.stacked) seenStack = true;
      if (g.crates.some(c => c.landingY > .71)) assert.equal(coverage.base, coverage.playable, 'no stacking before full floor');
      if ([600, 1200, 1800, 2160].includes(tick + 1)) {
        const target = [.08, .24, .52, .82][[600, 1200, 1800, 2160].indexOf(tick + 1)];
        assert.ok(Math.abs(coverage.percent / 100 - target) < .02, JSON.stringify(coverage));
      }
    }
    assert.equal(g.phase, 'roundOver'); assert.equal(g.timeout, true); assert.equal(g.elapsed, 20); assert.equal(g.snapshot().seconds, 0); assert.equal(g.coverage().percent, 100);
    assert.ok(g.elapsed <= 20); assert.equal(g.stats().kinematic, 0); assert.equal(g.invalidBodies, 0);
    if (g.cells.length < C.boxCap) assert.ok(seenStack);
    g.dispose();
  }
});
test('timeouts draw without extra time; last survivor wins immediately; full matches finish', () => {
  assert.equal(roundWinner([true, true]), null); assert.equal(roundWinner([false, true, false]), 1); assert.equal(roundWinner([false, false]), -1);
  const early = fixture(); early.players[0].alive = false; early.step(); assert.equal(early.winner, 1); assert.ok(early.elapsed < 1); early.dispose();
  for (const count of [2, 3] as const) {
    const g = new CrateRainGame(count, 87); g.spawning = false;
    run(g, 80); assert.equal(g.phase, 'results'); assert.equal(g.history.length, 3); assert.ok(g.history.every(r => r.seconds <= 20 && r.timeout)); assert.deepEqual(g.wins, Array(count).fill(0)); g.dispose();
  }
});
test('reset removes all bodies, colliders, reservations, warnings, and impacts for repeated rounds', () => {
  const g = fixture();
  for (let round = 0; round < 15; round++) {
    emptyRun(g); for (let i = 0; i < 60; i++) { const cell = g.cells[i]; g.addCrate('cedar', cell.x, i % 2 ? .7 : 9.7, cell.z); }
    run(g, .3); g.resetRound(); assert.equal(g.world.bodies.len(), 2); assert.equal(g.world.colliders.len(), 7); assert.equal(g.crates.length, 0); assert.equal(g.warnings.length, 0); assert.equal(g.impacts.length, 0); assert.ok(g.cells.every(c => !c.layers && !c.reserved));
  } g.dispose();
});
test('jump onto one crate, stand, walk a seam and climb a second level', () => {
  const g = fixture();
  const a = g.addCrate('cedar', .7, .7, -.7)!, b = g.addCrate('cedar', .7, .7, -2.1)!;
  g.addCrate('cedar', .7, .7, -3.5); g.addCrate('cedar', .7, 2.1, -3.5);
  run(g, .3); run(g, .27, { ...IDLE, z: -1, jump: true }); run(g, .85);
  const p = g.players[0]; assert.ok(p.grounded); assert.equal(p.support, a.id); assert.ok(p.body.translation().y > 2.1);
  const y = p.body.translation().y; run(g, 2); assert.ok(Math.abs(p.body.translation().y - y) < .002);
  run(g, .30, { ...IDLE, z: -1 }); run(g, .25); assert.equal(p.support, b.id); assert.ok(Math.abs(p.body.translation().y - y) < .02);
  run(g, .29, { ...IDLE, z: -1, jump: true }); run(g, 1); assert.ok(p.body.translation().y > 3.5); assert.ok(p.grounded); assert.ok(p.alive); g.dispose();
});
test('wall containment and edge coyote jump remain responsive', () => {
  const wall = fixture(); run(wall, 2, { ...IDLE, x: 1, sprint: true, jump: true }); assert.ok(wall.players[0].body.translation().x < C.arenaSize / 2 - .28); wall.dispose();
  const g = fixture(), p = g.players[0]; g.addCrate('cedar', .7, .7, .7); p.body.setTranslation({ x: .7, y: 2.2, z: .7 }, true); run(g, .5);
  let left = false; for (let i = 0; i < 150; i++) { g.step({ ...IDLE, x: 1 }); if (!p.grounded && p.coyote > .04) { left = true; break; } }
  assert.ok(left); g.step({ ...IDLE, x: 1, jump: true }); assert.ok(p.body.linvel().y > 8); g.dispose();
});
test('late and early warnings are visible, reactable at 250 ms, and use supported shadows', () => {
  for (const duration of [.65, .95]) {
    const g = fixture(), w = g.warn('cedar', .7, .7, duration)!, early = warningPose(g, w);
    run(g, .25); const late = warningPose(g, w); assert.ok(late.at.y < early.at.y); assert.ok(late.opacity > early.opacity);
    run(g, .6, { ...IDLE, x: 1, sprint: true }); assert.ok(g.players[0].alive); assert.ok(g.players[0].body.translation().x > 1.72); g.dispose();
  }
});
test('frame-independent shortest-arc facing across all eight directions and wraparound', () => {
  for (const [x, z] of [[0,-1],[-1,0],[0,1],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]]) {
    const target = Math.atan2(x,z), start = target + Math.PI * .75;
    const frames = [30,60,120].map(fps => { let yaw = start; for (let i = 0; i < fps; i++) yaw = smoothFacing(yaw,target,1/fps); return yaw; });
    assert.ok(Math.abs(frames[0] - frames[2]) < 1e-8); assert.ok(Math.abs(frames[0] - target) < .001);
    assert.ok(Math.abs(smoothFacing(start,target,1/60)-start) < .7);
  }
  assert.ok(smoothFacing(3.13,-3.13,1/60)>3.13);
});
test('bots cannot see future warnings, retain reaction time, and select reachable routes', () => {
  const sense: BotSense = { x: 0, y: FEET, z: 0, elapsed: 0, grounded: true, half: 7, warnings: [], height: () => 0, clear: () => true };
  const a = new CrateBot(1, seeded(17)), b = new CrateBot(1, seeded(17));
  assert.deepEqual(a.think(sense), b.think({ ...sense, warnings: [{ id: 1, x: 0, z: 0, radius: .7, since: 0 }] }));
  const reacting = a.think({ ...sense, elapsed: 1, warnings: [{ id: 1, x: 0, z: 0, radius: .7, since: 0 }] }); assert.ok(reacting.sprint); assert.ok(Math.hypot(reacting.x, reacting.z) > .9);
});
test('default keyboard look, rebindings, conflicts, aliases and camera fresh-press edges', () => {
  const b = crateBindings(defaultBindings()); assert.equal(b.camera[0], 'KeyV'); assert.deepEqual(b.moveForward, ['KeyW', null]); assert.equal(b.lookUp[0], 'ArrowUp');
  const i = new CrateInput(b); i.set('KeyV', true); assert.equal(i.read().camera, true);
  for (let n = 0; n < 20; n++) { i.set('KeyV', true); assert.equal(i.read().camera, false); }
  i.set('KeyV', false); i.set('KeyV', true); assert.equal(i.read().camera, true);
  i.set('ArrowLeft', true); i.set('ArrowUp', true); assert.deepEqual([i.read().yaw, i.read().pitch], [1, -1]);
  const changed = changeCrateBinding(b, 'camera', 0, 'KeyB')!; assert.equal(crateBindingLabel(changed, 'camera'), 'B');
  assert.equal(changeCrateBinding(b, 'camera', 0, 'KeyW'), null); assert.equal(changeCrateBinding(b, 'jump', 0, 'MouseLeft'), null);
  const custom = crateBindings({ ...defaultBindings(), moveForward: ['ArrowUp', 'KeyV'] });
  assert.deepEqual(custom.moveForward, ['ArrowUp', 'KeyV']); assert.notEqual(custom.lookUp[0], 'ArrowUp'); assert.notEqual(custom.camera[0], 'KeyV');
  i.clear(); assert.equal(i.read().yaw, 0); assert.equal(i.read().camera, false);
});
test('camera movement basis has no feedback from character spin in either view', () => {
  for (const view of ['third','first'] as const) for (const yaw of [0,.7,1.5,3.14]) {
    const camera = new CrateCamera(); camera.yaw = yaw;
    for (let i = 0; i < 240; i++) assert.deepEqual(camera.steer({ ...IDLE, x: 1, yaw: 0, pitch: 0 }, view, C.step), viewMovement({ ...IDLE, x: 1, yaw: 0, pitch: 0 } as typeof IDLE, yaw));
    assert.ok(Math.abs(camera.yaw-yaw)<1e-8);
  }
});
test('third-person obstruction pull-in, FPS body hide, natural mouse/keyboard look', () => {
  const g = fixture(), c = new CrateCamera(), camera = new PerspectiveCamera(); c.reset(g); c.yaw = 0;
  c.update(camera,g,'third',.1); assert.equal(camera.fov,CRATE_CAMERA.thirdFov); const clear=c.distance;
  g.addCrate('cedar',.7,.7,2.1); g.addCrate('cedar',.7,2.1,2.1); run(g,.1);
  c.update(camera,g,'third',.1); assert.ok(c.distance < clear-1);
  c.update(camera,g,'first',.1); assert.ok(Math.abs(camera.position.y-CRATE_CAMERA.eye)<.06); assert.equal(camera.fov,78); assert.ok(c.hiddenPlayer);
  c.steer({...IDLE,yaw:0,pitch:0},'first',1/60,{dx:100,dy:-80}); assert.ok(c.yaw<-.29); assert.ok(c.pitch<-.23);
  for(let i=0;i<120;i++)c.steer({...IDLE,yaw:1,pitch:-1},'first',C.step);
  c.update(camera,g,'first',.1); assert.ok(camera.getWorldDirection(camera.position.clone()).y>.8);
  assert.equal(nextCrateView('third'),'first'); assert.equal(nextCrateView('first'),'third');g.dispose();
});
