import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { initializePhysics } from '../physics';
import { SNOWBALL as C, IDLE } from './config';
import { SnowballGame } from './game';
import { snowballScreenInput } from './screenInput';
import { contactSeparation, impactAuthority, SNOWBALL_CONTACT } from '../../../../shared/party-lab/simulation/snowball/contact';

before(initializePhysics);
type Pose = [number, number, number, number];
// Fixture placement only. All motion after this point comes from the game and Rapier.
function collision(a: Pose, b: Pose, counter = false, assist = true) {
  const g = new SnowballGame(2); g.bots = false; g.phase = 'playing';
  if (!assist) { const step = g.stepPhysics.bind(g); g.stepPhysics = () => step(false); }
  [a, b].forEach(([x, z, vx, vz], i) => {
    const ball = g.balls[i]; ball.heading = Math.PI / 2;
    ball.body.setTranslation({ x, y: C.radius + .016, z }, true);
    ball.body.setLinvel({ x: vx, y: 0, z: vz }, true);
    ball.body.setAngvel({ x: vz / C.radius, y: 0, z: -vx / C.radius }, true);

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

test('soft recoil floor is continuous, bounded at tiny speeds and grows with approach', () => {
  assert.equal(contactSeparation(-1), 0); assert.equal(contactSeparation(0), 0);
  assert.ok(contactSeparation(.001) < .009);
  let previous = 0;
  for (let v = .001; v <= 30; v += .013) {
    const separation = contactSeparation(v);
    assert.ok(separation > previous); previous = separation;
    assert.ok(separation <= .85*v+3);
  }
});

test('slow through full-speed impacts visibly separate both bodies; speed hierarchy survives', () => {
  const results = [.5,1,2,4,6,8,9.15].map(speed => {
    const a: Pose = [-.968,0,speed,0], b: Pose = [.968,0,0,0];
    const old = collision(a,b,false,false), tuned = collision(a,b);
    assert.ok(tuned.separation > old.separation+2, 'low speed has a meaningful normal recoil');
    assert.ok(tuned.post[0].x < 0 && tuned.post[1].x > 0, 'attacker reacts too');
    assert.ok(tuned.one[1] > old.one[1]);
    assert.ok(tuned.minDistance > C.radius*2-.02);
    assert.ok(tuned.one[1] < 8, 'no cross-arena launch in the first second');
    const da=tuned.post[0].x-old.post[0].x, db=tuned.post[1].x-old.post[1].x;
    assert.ok(Math.abs(da+db)<.001, 'assistance conserves pair momentum');
    return tuned;
  });
  assert.ok(results[0].one[1]>.8 && results[0].one[1]<1.2);
  assert.ok(results[1].one[1]>1.3 && results[1].one[1]<1.8);
  assert.ok(results[3].one[1]>3 && results[3].one[1]<4);
  for(let i=1;i<results.length;i++)assert.ok(results[i].one[1]>results[i-1].one[1]);
});

test('matched head-on collisions recoil symmetrically with input continuously accepted', () => {
  for(const speed of [.5,1,2,4,6,8]) {
    const a:Pose=[-.968,0,speed/2,0],b:Pose=[.968,0,-speed/2,0];
    const old=collision(a,b,true,false),r=collision(a,b,true);
    assert.ok(r.post[0].x<0 && r.post[1].x>0);
    assert.ok(Math.abs(r.post[0].x+r.post[1].x)<.01);
    assert.ok(r.nextSeparation>r.separation*.94);
    assert.ok(r.half.every((d,i)=>d>old.half[i]+.04));
  }
  assert.equal(impactAuthority(SNOWBALL_CONTACT.recoverySeconds), .15);
  assert.equal(impactAuthority(0), 1);
  assert.ok(impactAuthority(.09)>.5 && impactAuthority(.09)<.6);
});

test('side, 45 degree and shallow glancing assistance follows only the actual normal', () => {
  for(const angle of [0,Math.PI/4,Math.PI*75/180]) {
    const x=Math.cos(angle)*.968,z=Math.sin(angle)*.968;
    const a:Pose=[-x,-z,8,0],b:Pose=[x,z,0,angle===0?4:0];
    const old=collision(a,b,false,false),r=collision(a,b);
    const da={x:r.post[0].x-old.post[0].x,z:r.post[0].z-old.post[0].z};
    const db={x:r.post[1].x-old.post[1].x,z:r.post[1].z-old.post[1].z};
    assert.ok(da.x<0 && db.x>0);
    assert.ok(Math.hypot(da.x+db.x,da.z+db.z)<.002);
    if(angle>0)assert.ok(da.z<0 && db.z>0, 'normal is not attacker heading');
    assert.ok(r.minDistance>C.radius*2-.02);
  }
});

test('a medium edge hit beats active counter-input, while center slow hits stay survivable', () => {
  const a:Pose=[7.5-1.936,0,4,0],b:Pose=[7.5,0,0,0];
  assert.deepEqual(collision(a,b,true,false).alive,[true,true]);
  // At one metre from the physical edge, a medium clean hit is dangerous even braced.
  assert.equal(collision([9-1.936,0,4,0],[9,0,0,0],true).alive[1],false);
  assert.deepEqual(collision([-.968,0,.5,0],[.968,0,0,0]).alive,[true,true]);
});

test('stationary, separating and speculative contacts cannot create assisted recoil', () => {
  for(const speed of [0,-1]) {
    const g=new SnowballGame(2);g.phase='playing';g.bots=false;
    g.balls.forEach((b,i)=>{b.body.setTranslation({x:i? .963:-.963,y:.966,z:0},true);b.body.setLinvel({x:i?0:speed,y:0,z:0},true);});
    for(let i=0;i<12;i++)g.step();
    assert.ok(g.balls.every(b=>b.impactRemaining===0));assert.equal(g.collisionCount,0);g.dispose();
  }
});

test('impact state resets, restores exactly, and rejects malformed/legacy payloads', () => {
  const g=new SnowballGame(3);
  assert.ok(g.restoreContactState([.18,.1,0,38]));assert.deepEqual(g.contactState(),[.18,.1,0,38]);
  for(const invalid of [[],[.18,.1,0,39],[.18,.1,0,2**32+2],[.19,0,0,0],[NaN,0,0,0]]) {
    assert.equal(g.restoreContactState(invalid),false);assert.deepEqual(g.contactState(),[0,0,0,0]);
  }
  g.restoreContactState([.18,.1,0,38]);g.resetRound();assert.deepEqual(g.contactState(),[0,0,0,0]);g.dispose();
});

test('released three-body chains settle rather than feeding endless bounce loops', () => {
  const g=new SnowballGame(3,100);g.phase='playing';g.bots=false;
  g.balls.forEach((b,i)=>{const vx=i===0?1:0;b.body.setTranslation({x:(i-1)*2.1,y:.966,z:0},true);b.body.setLinvel({x:vx,y:0,z:0},true);b.body.setAngvel({x:0,y:0,z:-vx/C.radius},true);});
  let max=0;
  for(let i=0;i<1200;i++){g.step();for(const b of g.balls)max=Math.max(max,Math.hypot(b.body.linvel().x,b.body.linvel().z));}
  assert.ok(max<4);assert.ok(g.collisionCount>=2 && g.collisionCount<6);assert.equal(g.invalidBodies,0);
  assert.ok(g.balls.every(b=>b.impactRemaining===0));g.dispose();
});
