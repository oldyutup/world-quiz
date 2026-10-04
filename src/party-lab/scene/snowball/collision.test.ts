import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { initializePhysics } from '../physics';
import { SNOWBALL as C, IDLE } from './config';
import { SnowballGame } from './game';
import { snowballScreenInput } from './screenInput';

before(initializePhysics);
type Pose = [number, number, number, number];
// Fixture placement only. All motion after this point comes from the game and Rapier.
function collision(a: Pose, b: Pose, counter = false, restitution: number = C.restitution) {
  const g = new SnowballGame(2); g.bots = false; g.phase = 'playing';
  [a, b].forEach(([x, z, vx, vz], i) => {
    const ball = g.balls[i]; ball.heading = Math.PI / 2;
    ball.body.setTranslation({ x, y: C.radius + .016, z }, true);
    ball.body.setLinvel({ x: vx, y: 0, z: vz }, true);
    ball.body.setAngvel({ x: vz / C.radius, y: 0, z: -vx / C.radius }, true);
    ball.body.collider(0).setRestitution(restitution);
  });
  let hit = -1, separation = 0, nextSeparation = 0, minDistance = Infinity;
  let pre = g.balls.map(b => b.body.linvel()), post = pre;
  let origin = g.balls.map(b => b.body.translation());
  let half = [0, 0], one = [0, 0];
  let normal = { x: 1, z: 0 };
  try {
    for (let tick = 0; tick < 500; tick++) {
      const previous = g.balls.map(b => b.body.linvel());
      const positions = g.balls.map(b => b.body.translation());
      const inputs = g.balls.map((b, i) => {
        if (!counter || hit < 0) return IDLE;
        const sign = i === 0 ? 1 : -1, v = b.body.linvel();
        return snowballScreenInput(normal.x * sign, normal.z * sign, b.heading, Math.hypot(v.x, v.z));
      });
      g.step(inputs[0], inputs);
      let impulse = 0;
      g.world.contactPair(g.balls[0].body.collider(0), g.balls[1].body.collider(0), m => {
        for (let i = 0; i < m.numContacts(); i++) impulse += m.contactImpulse(i);
      });
      const p = g.balls.map(b => b.body.translation()), v = g.balls.map(b => b.body.linvel());
      if (g.balls.every(b => b.alive)) minDistance = Math.min(minDistance, Math.hypot(p[1].x-p[0].x, p[1].y-p[0].y, p[1].z-p[0].z));
      if (hit < 0 && impulse > .01) {
        hit = tick; pre = previous; post = v; origin = p;
        const dx = positions[1].x-positions[0].x, dz = positions[1].z-positions[0].z, d = Math.hypot(dx, dz);
        normal = { x: dx/d, z: dz/d };
        separation = (v[1].x-v[0].x)*normal.x + (v[1].z-v[0].z)*normal.z;
      }
      if (hit >= 0) {
        const displacement = () => p.map((p, i) => Math.hypot(p.x-origin[i].x, p.z-origin[i].z));
        if (tick-hit === 1) nextSeparation = (v[1].x-v[0].x)*normal.x + (v[1].z-v[0].z)*normal.z;
        if (tick-hit === 60) half = displacement();
        if (tick-hit === 120) one = displacement();
        if (tick-hit >= 300) break;
      }
    }
    assert.ok(hit >= 0, 'must measure an actual impulse, not a speculative contact');
    assert.equal(g.invalidBodies, 0);
    return { pre, post, separation, nextSeparation, half, one, minDistance, alive: g.balls.map(b => b.alive) };
  } finally { g.dispose(); }
}

test('more ball recoil leaves ice restitution, mass, friction and contact setup intact', () => {
  const g = new SnowballGame(2);
  try {
    assert.equal(C.restitution, .70);
    assert.equal(g.floor.restitution(), 0);
    assert.equal(g.floor.restitutionCombineRule(), RAPIER.CoefficientCombineRule.Min);
    for (const b of g.balls) {
      const c = b.body.collider(0);
      assert.ok(Math.abs(c.restitution()-.70)<1e-6);
      assert.equal(c.restitutionCombineRule(), RAPIER.CoefficientCombineRule.Average);
      assert.ok(Math.abs(c.friction()-.22)<1e-6);
      assert.ok(Math.abs(c.contactSkin()-.015)<1e-6);
      assert.ok(Math.abs(b.body.mass()-80)<1e-5);
      assert.ok(b.body.isCcdEnabled());
    }
  } finally { g.dispose(); }
});

test('low, medium and full impacts scale with incoming speed and increase separation moderately', () => {
  const results = [1.5, 5.5, 9.15].map(speed => {
    const a: Pose = [-3,0,speed,0], b: Pose = [0,0,0,0];
    const old = collision(a,b,false,.55), tuned = collision(a,b);
    assert.ok(tuned.separation > old.separation*1.25 && tuned.separation < old.separation*1.29);
    assert.ok(tuned.one[1] > old.one[1]);
    assert.ok(tuned.one[0] < old.one[0], 'attacker also pays for the stronger momentum transfer');
    assert.ok(tuned.minDistance > C.radius*2-.02);
    assert.deepEqual(tuned.alive,[true,true], 'center hit is not an instant elimination');
    const before = tuned.pre.reduce((n,v)=>n+v.x*v.x+v.z*v.z,0);
    const after = tuned.post.reduce((n,v)=>n+v.x*v.x+v.z*v.z,0);
    assert.ok(after < before, 'contact does not manufacture kinetic energy');
    return tuned;
  });
  assert.ok(results[0].one[1] < .8 && results[0].separation < 1);
  assert.ok(results[2].one[1] > results[1].one[1]*1.6);
});

test('equal-speed head-on reverses both spheres and counter-input cannot erase the first impulse', () => {
  const r = collision([-3,0,8,0],[3,0,-8,0],true);
  assert.ok(r.post[0].x < -5 && r.post[1].x > 5);
  assert.ok(Math.abs(r.post[0].x+r.post[1].x)<.06);
  assert.ok(r.nextSeparation > r.separation*.97);
  assert.ok(r.half.every(d=>d>.7 && d<1), 'both recoil visibly even with immediate counter-input');
  assert.ok(r.one.every(d=>d<.25), 'continued control can recover; no stun');
});

test('side and glancing hits redirect momentum without an explosive speed bonus', () => {
  const side = collision([-3,0,9.15,0],[0,-.68,0,5.5]);
  const glance = collision([-3,1.55,9.15,0],[0,0,0,0]);
  assert.ok(side.post[1].x > 5 && side.post[0].x < 3);
  assert.ok(glance.post[1].z < -2 && glance.post[0].z > 2);
  assert.ok(glance.separation < side.separation*.7);
  for (const r of [side,glance]) {
    const before = r.pre.reduce((n,v)=>n+v.x*v.x+v.z*v.z,0);
    const after = r.post.reduce((n,v)=>n+v.x*v.x+v.z*v.z,0);
    assert.ok(after < before);
    assert.ok(r.minDistance > C.radius*2-.02);
  }
});

test('edge ram defeats a braced defender where the old contact recovered; weak taps remain survivable', () => {
  const a: Pose = [4.5,0,9.15,0], b: Pose = [7.5,0,0,0];
  assert.deepEqual(collision(a,b,true,.55).alive,[true,true]);
  assert.deepEqual(collision(a,b,true).alive,[true,false]);
  assert.deepEqual(collision([4.5,0,1.5,0],b).alive,[true,true]);
});
