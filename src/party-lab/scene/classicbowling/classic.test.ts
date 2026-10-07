import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePhysics } from '../physics';
import { InputManager } from '../../input/inputManager';
import { defaultBindings } from '../../input/defaults';
import { actionBindingLabel, changeBinding } from '../../input/bindings';
import { CLASSIC as C, ballSpeed, directionAt, positionAt, powerAt, rackPositions, sweep } from './config';
import { ClassicGame, pinIsDown } from './game';
import { ClassicScore } from './rules';
import { botPlan, phaseTime, seededRandom } from './bot';
import { NET } from '../../../../shared/party-lab/network/protocol';
import { PerspectiveCamera } from 'three';
import { classicCamera, CLASSIC_CAMERA } from './camera';
await initializePhysics();
function withGame(fn: (g: ClassicGame) => void, count: 2 | 3 = 2) { const g = new ClassicGame(count); g.bots = false; try { fn(g); } finally { g.dispose(); } }
function launch(g: ClassicGame, x = 0, angle = 0, power = 65) { g.position = x; g.select(); g.angle = angle; g.select(); g.power = power; g.select(); }
function finish(g: ClassicGame) { for (let i = 0; i < 600 && g.phase === 'rolling'; i++) g.advance(1 / 60); assert.equal(g.phase, 'feedback'); }
function next(g: ClassicGame) { while (g.phase === 'feedback' || g.phase === 'return') g.advance(1 / 60); }

test('local identity, protocol 14 and supported seats', () => { assert.equal(C.id, 'classic_bowling'); assert.equal(NET.version, 14); assert.throws(() => new ClassicScore(4 as 2)); });
test('position, direction, power sweeps repeat for arbitrarily late selection', () => {
  for (const t of [0, .17, 1.3, 60, 1234]) {
    assert.ok(Math.abs(positionAt(t) - positionAt(t + 1.35)) < 1e-10);
    assert.ok(Math.abs(directionAt(t) - directionAt(t + 1.65)) < 1e-10);
    assert.ok(Math.abs(powerAt(t) - powerAt(t + 3)) < 1e-10);
  }
  for (let t = 0; t < 30; t += .007) { assert.ok(Math.abs(positionAt(t)) <= .56); assert.ok(Math.abs(directionAt(t)) <= 6.5); assert.ok(powerAt(t) >= 35 && powerAt(t) <= 100); }
  assert.equal(sweep(.9, 1.8), 1); assert.equal(sweep(2.7, 1.8), -1);
  assert.ok(C.positionRange + C.ballRadius < C.laneWidth / 2);
});
test('presentation clocks do not depend on physical step count', () => withGame(g => { g.advance(.675); assert.ok(Math.abs(g.position) < 1e-10); assert.equal(g.launches, 0); g.advance(6); assert.equal(g.phase, 'position'); }));
test('three fresh action presses lock exactly three phases and launch once', () => withGame(g => {
  const input = new InputManager();
  for (const phase of ['direction', 'power', 'rolling']) {
    input.setBindingDown('Space', true); g.advance(1 / 60, input.readIntent().jump); assert.equal(g.phase, phase);
    for (let i = 0; i < 12; i++) { input.setBindingDown('Space', true); g.advance(1 / 60, input.readIntent().jump); }
    assert.equal(g.phase, phase); input.setBindingDown('Space', false);
  }
  assert.equal(g.launches, 1); assert.equal(g.stats().dynamic, 11);
}));
test('fast released taps survive polling and values remain locked', () => withGame(g => {
  const input = new InputManager();
  input.setBindingDown('Space', true); input.setBindingDown('Space', false); g.advance(.1, input.readIntent().jump);
  const x = g.position; g.advance(9); assert.equal(g.position, x); assert.equal(g.phase, 'direction');
  g.advance(.1, true); const a = g.angle; g.advance(9); assert.equal(g.angle, a); assert.equal(g.phase, 'power');
}));
test('rebind uses semantic action, old Space stops and label changes; restore works', () => withGame(g => {
  const b = changeBinding(defaultBindings(), 'jump', 0, 'KeyQ')!; const input = new InputManager(b);
  assert.equal(actionBindingLabel(b, 'jump'), 'Q');
  input.setBindingDown('Space', true); g.advance(.01, input.readIntent().jump); assert.equal(g.phase, 'position');
  for (const phase of ['direction', 'power', 'rolling']) { input.setBindingDown('KeyQ', true); g.advance(.01, input.readIntent().jump); assert.equal(g.phase, phase); input.setBindingDown('KeyQ', false); }
  input.setBindings(defaultBindings()); input.setBindingDown('KeyQ', true); assert.equal(input.readIntent().jump, false);
  input.setBindingDown('Space', true); assert.equal(input.readIntent().jump, true);
}));
test('suspension and binding changes clear queued presses', () => { const input = new InputManager(); input.setBindingDown('Space', true); input.setSuspended(true); input.setSuspended(false); assert.equal(input.readIntent().jump, false); });
test('power maps continuously to actual launch velocity with forward rolling and selective CCD', () => {
  assert.equal(ballSpeed(35), 4); assert.equal(ballSpeed(100), 9.5); assert.equal(ballSpeed(67.5), 6.75);
  for (const power of [35, 55, 78, 100]) withGame(g => { launch(g, -.2, 2, power); const v = g.ball!.linvel(); assert.ok(Math.abs(Math.hypot(v.x, v.z) - ballSpeed(power)) < 1e-5); assert.equal(g.ball!.isCcdEnabled(), true); assert.equal(g.ball!.angvel().y, 0); });
});
test('ten-pin rack has standard equilateral spacing and no overlap', () => {
  const pins = rackPositions(); assert.equal(pins.length, 10);
  for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) assert.ok(Math.hypot(pins[i].x - pins[j].x, pins[i].z - pins[j].z) > C.pinRadius * 2);
  assert.ok(Math.abs(Math.hypot(pins[0].x - pins[1].x, pins[0].z - pins[1].z) - C.spacing) < 1e-9);
});
test('untouched physical pins remain upright for 20 seconds', () => withGame(g => {
  for (let n = 0; n < 2400; n++) g.world.step();
  for (const p of g.pins) { assert.equal(pinIsDown(p.body.translation(), p.body.rotation()), false); assert.ok(Math.abs(p.body.translation().y) < .01); assert.ok(Math.abs(p.body.mass() - C.pinMass) < 1e-6); }
}));
test('gutter physically travels onward, no deletion or unearned pins', () => withGame(g => {
  launch(g, .55, 6.5, 35);
  for (let i = 0; i < 100; i++) g.advance(1 / 60);
  assert.ok(g.ball!.translation().y < 0); assert.ok(g.ball!.translation().z > 5); assert.ok(g.pins.every(p => !p.down));
  finish(g); const m = g.measurements[0]; assert.equal(m.gutter, true); assert.equal(m.pins, 0); assert.equal(m.impactTime, null); assert.ok(m.path[m.path.length - 1].z > C.deckEnd);
}));
test('tilt/off-deck rule ignores upright movement and modest wobble', () => {
  const p = { x: 0, y: 0, z: 10.5 }, q = (deg: number) => ({ x: Math.sin(deg * Math.PI / 360), y: 0, z: 0, w: Math.cos(deg * Math.PI / 360) });
  assert.equal(pinIsDown(p, q(0)), false); assert.equal(pinIsDown(p, q(30)), false); assert.equal(pinIsDown(p, q(60)), true); assert.equal(pinIsDown({ ...p, y: -.2 }, q(0)), true);
});
test('one-frame topple is not scored; sustained tilt is', () => withGame(g => {
  launch(g, .55, 6.5, 100); const p = g.pins[0];
  p.body.setRotation({ x: .7071, y: 0, z: 0, w: .7071 }, true); g.advance(1 / 120); assert.equal(p.down, false);
  p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true); g.advance(1 / 120); assert.equal(p.downFor, 0);
  p.body.setRotation({ x: .7071, y: 0, z: 0, w: .7071 }, true);
  for (let n = 0; n < 30; n++) g.advance(1 / 120); assert.equal(p.down, true);
}));
test('physical first roll scores only after settling; second rack contains only survivors', () => withGame(g => {
  launch(g); while (g.ball!.translation().z < 9) g.advance(1 / 60); assert.equal(g.score.totals[0], 0);
  finish(g); const m = g.measurements[0]; assert.ok(m.pins > 0 && m.pins < 10); assert.equal(g.score.totals[0], m.downIds.length); assert.ok(m.settleTime >= 1.6);
  const ids = g.pins.filter(p => !p.down).map(p => p.id); next(g);
  assert.equal(g.score.roll, 2); assert.deepEqual(g.pins.map(p => p.id), ids); assert.equal(g.ball, null); assert.equal(g.phase, 'position');
  for (const p of g.pins) { const target = rackPositions()[p.id], actual = p.body.translation(); assert.ok(Math.abs(target.x - actual.x) <= .0016 && Math.abs(target.z - actual.z) <= .0016); }
  launch(g, .55, 6.5, 65); finish(g); assert.equal(g.measurements[1].pins, 0); next(g);
  assert.equal(g.score.seat, 1); assert.equal(g.score.roll, 1); assert.equal(g.pins.length, 10);
}));
test('strike scores 10 and skips second roll without future bonuses', () => {
  const s = new ClassicScore(2); assert.equal(s.record(10), 'strike'); assert.equal(s.advance(), 'rack'); assert.equal(s.seat, 1); assert.equal(s.roll, 1); assert.deepEqual(s.totals, [10, 0]);
});
test('spare totals at most ten and an open frame adds the two rolls', () => {
  const s = new ClassicScore(2); s.record(7); assert.equal(s.advance(), 'spare'); assert.throws(() => s.record(4)); assert.equal(s.record(3), 'spare'); s.advance(); s.record(4); s.advance(); assert.equal(s.record(2), 'open'); s.advance(); assert.deepEqual(s.totals, [10, 6]);
});
test('2P and 3P order alternates seats frame by frame; winner and draw', () => {
  for (const count of [2, 3] as const) {
    const s = new ClassicScore(count), order = [];
    while (!s.finished) { order.push([s.frame, s.seat]); s.record(10); s.advance(); }
    assert.deepEqual(order, Array.from({ length: 3 }, (_, frame) => Array.from({ length: count }, (_, seat) => [frame, seat])).flat()); assert.deepEqual(s.winners, Array.from({ length: count }, (_, i) => i)); assert.ok(s.totals.every(n => n === 30)); assert.throws(() => s.record(0));
  }
  const s = new ClassicScore(2); while (!s.finished) { if (s.seat === 0) s.record(10); else { s.record(2); s.advance(); s.record(3); } s.advance(); } assert.deepEqual(s.winners, [0]);
});
test('bot plans choose reachable phase times and contain distinct tendencies', () => {
  const random = seededRandom(987); const styles = ['straight', 'angle', 'power'] as const;
  const plans = styles.map(style => botPlan(random, style, rackPositions()));
  assert.deepEqual(plans.map(p => p.style), styles); assert.ok(plans.every(p => p.position >= 0 && p.direction >= 0 && p.power >= 0));
  for (const v of [-1, -.7, -.1, 0, .1, .7, 1]) assert.ok(Math.abs(sweep(phaseTime(v, 2), 2) - v) < 1e-9);
});
test('bots pass through all three phases and use the same velocity mapping', () => withGame(g => {
  g.bots = true; g.autoHuman = true; const phases = new Set<string>();
  for (let n = 0; n < 1200 && !g.ball; n++) { phases.add(g.phase); g.advance(1 / 60); }
  assert.deepEqual([...phases], ['position', 'direction', 'power']); assert.equal(g.launches, 1); assert.ok(Math.abs(Math.hypot(g.ball!.linvel().x, g.ball!.linvel().z) - ballSpeed(g.power)) < 1e-5);
}));
test('physical strikes and non-empty spare conversions occur without pin assistance', () => {
  let strike = false, spare = false;
  for (let seed = 1; seed <= 12 && (!strike || !spare); seed++) {
    const g = new ClassicGame(2, seed); g.autoHuman = true;
    try {
      for (let n = 0; n < 40000 && g.phase !== 'results'; n++) g.advance(1 / 60);
      assert.equal(g.phase, 'results');
      for (const card of g.score.cards) for (const frame of card) {
        if (frame.kind === 'strike') { strike = true; assert.deepEqual(frame.rolls, [10]); }
        if (frame.kind === 'spare' && frame.rolls[0] > 0) { spare = true; assert.equal(frame.rolls[0] + frame.rolls[1], 10); }
      }
      assert.equal(g.stats().invalid, 0); assert.equal(g.ball, null);
      assert.ok(g.score.cards.flat().every(f => f.kind !== null));
    } finally { g.dispose(); }
  }
  assert.ok(strike); assert.ok(spare);
});
test('small direction changes produce continuous pre-impact paths with no lateral drift', () => {
  const xs = [-.2, 0, .2].map(a => { let x = 0; withGame(g => { launch(g, 0, a, 78); for (let n = 0; n < 30; n++) g.advance(1 / 60); x = g.ball!.translation().x; }); return x; });
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2]); assert.ok(Math.abs(xs[1]) < .0001); assert.ok(Math.abs(xs[0] + xs[2]) < .0001);
});
test('fixed camera keeps rotation/FOV constant through roll and return; reduced motion stays fixed', () => withGame(g => {
  const view = classicCamera(), cam = new PerspectiveCamera(); view.update(cam, g, 1 / 60); const q = cam.quaternion.clone();
  launch(g); for (let n = 0; n < 180; n++) { g.advance(1 / 60); view.update(cam, g, 1 / 60); }
  assert.ok(cam.position.z > -CLASSIC_CAMERA.behind); assert.ok(cam.quaternion.angleTo(q) < .00001); assert.equal(cam.fov, 46);
  for (let n = 0; n < 300; n++) view.update(cam, g, 1 / 60, true);
  assert.ok(Math.abs(cam.position.z + CLASSIC_CAMERA.behind) < .001);
}));
