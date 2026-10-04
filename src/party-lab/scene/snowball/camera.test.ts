import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { initializePhysics } from '../physics';
import { snowballArenaCamera } from './camera';
import { snowballScreenInput } from './screenInput';
import { SNOWBALL as C } from './config';
import { SnowballGame } from './game';

before(initializePhysics);

test('fixed arena pose mirrors Rooftop elevation, target, lens and narrow-screen framing', () => {
  for (const [width, height] of [[1440, 900], [1366, 768], [768, 1024]]) {
    const pose = snowballArenaCamera(width, height);
    const scale = 1.6 * Math.max(1, 1.5 / (width / height));
    assert.deepEqual(pose.position, [0, 12 * scale, 14 * scale]);
    assert.deepEqual(pose.target, [0, 0, 0]);
    assert.equal(pose.fov, 45);
  }
  assert.deepEqual(snowballArenaCamera(1440, 900), snowballArenaCamera(1366, 768));
});

test('full platform, standing balls and labels fit both requested viewports with margin', () => {
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    const pose = snowballArenaCamera(width, height);
    const cam = new PerspectiveCamera(pose.fov, width / height, 0.1, 180);
    cam.position.set(...pose.position); cam.lookAt(...pose.target); cam.updateMatrixWorld();
    for (let i = 0; i < 360; i++) {
      const a = i * Math.PI / 180;
      for (const y of [-1.3, 0, C.radius * 2, C.radius + 1.8]) {
        const p = new Vector3(Math.sin(a) * (C.arenaRadius + C.radius), y, Math.cos(a) * (C.arenaRadius + C.radius)).project(cam);
        assert.ok(Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9, `${width}×${height}: ${p.toArray()}`);
      }
    }
    const origin = new Vector3().project(cam);
    assert.ok(new Vector3(1, 0, 0).project(cam).x > origin.x);
    assert.ok(new Vector3(0, 0, -1).project(cam).y > origin.y);
  }
});

test('input uses fixed screen directions, opposing keys cancel, diagonal does not boost thrust', () => {
  assert.deepEqual(snowballScreenInput(0, 0, 2, 8), { throttle: 0, steer: 0 });
  assert.deepEqual(snowballScreenInput(0, -1, 0, 0), { throttle: 1, steer: 0 });
  assert.deepEqual(snowballScreenInput(0, 1, 0, 0), { throttle: -1, steer: 0 });
  assert.equal(snowballScreenInput(-1, 0, 0, 0).steer, -1);
  assert.equal(snowballScreenInput(1, 0, 0, 0).steer, 1);
  for (const heading of [0, 0.8, -1.6, Math.PI, -Math.PI]) for (const speed of [0, 5, 11]) {
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1]]) {
      const input = snowballScreenInput(x, z, heading, speed);
      assert.ok(Math.abs(input.throttle) <= 1 && Math.abs(input.steer) <= 1);
      // Still governed by the existing motor's speed-dependent turn limit.
      const delta = input.steer * C.turnRate / (1 + speed * 0.12) * C.step;
      assert.ok(Math.abs(delta) <= C.turnRate / (1 + speed * 0.12) * C.step);
    }
  }
});

function setup(heading: number, vx = 0, vz = 0) {
  const game = new SnowballGame(2); game.bots = false; game.phase = 'playing';
  const b = game.balls[0]; b.heading = heading;
  b.body.setTranslation({ x: 0, y: C.radius + 0.016, z: 0 }, true);
  b.body.setLinvel({ x: vx, y: 0, z: vz }, true);
  b.body.setAngvel({ x: vz / C.radius, y: 0, z: -vx / C.radius }, true);
  game.balls[1].body.setTranslation({ x: 7, y: C.radius + 0.016, z: 7 }, true);
  return game;
}
function drive(game: SnowballGame, x: number, z: number, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    const b = game.balls[0], v = b.body.linvel();
    game.step(snowballScreenInput(x, z, b.heading, Math.hypot(v.x, v.z)));
  }
}

test('W/S/A/D move in screen-requested direction from different headings using the shared motor', () => {
  for (const heading of [0, 0.8, -1.6, Math.PI]) for (const [x, z] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const game = setup(heading);
    try {
      drive(game, x, z, 180);
      const p = game.balls[0].body.translation();
      assert.ok(p.x * x + p.z * z > 0.7, `${heading}, ${x}, ${z}: ${JSON.stringify(p)}`);
      assert.equal(game.invalidBodies, 0);
    } finally { game.dispose(); }
  }
});

test('opposite screen direction brakes gradually; releasing preserves momentum', () => {
  const game = setup(Math.PI / 2, 5);
  try {
    drive(game, -1, 0, 12);
    assert.ok(game.balls[0].body.linvel().x > 3, 'counter-force is faster but cannot reverse 5 m/s instantly');
    drive(game, -1, 0, 228);
    assert.ok(game.balls[0].body.linvel().x < -0.5, 'eventually reverses left');
    const speed = Math.abs(game.balls[0].body.linvel().x);
    drive(game, 0, 0, 60);
    assert.ok(Math.abs(game.balls[0].body.linvel().x) > speed * 0.8, 'release coasts');
  } finally { game.dispose(); }
});

test('sphere orientation cannot change the input basis', () => {
  const games = [setup(0.8), setup(0.8)];
  try {
    games[1].balls[0].body.setRotation({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 }, true);
    games.forEach(game => drive(game, 1, -1, 120));
    const a = games[0].balls[0].body.translation(), b = games[1].balls[0].body.translation();
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.001);
  } finally { games.forEach(game => game.dispose()); }
});
