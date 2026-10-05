import fs from 'node:fs';
import assert from 'node:assert/strict';
import { initializePhysics } from '../src/party-lab/scene/physics';
import { ClassicGame, type ThrowMeasurement } from '../src/party-lab/scene/classicbowling/game';
import { CLASSIC as C } from '../src/party-lab/scene/classicbowling/config';
import { botPlan, seededRandom } from '../src/party-lab/scene/classicbowling/bot';
await initializePhysics();
const out = process.argv[2] ?? '/private/tmp/classic-bowling-validation';
fs.mkdirSync(out, { recursive: true });
function finish(g: ClassicGame, count = 1) {
  for (let n = 0; n < 12000 && g.measurements.length < count; n++) g.advance(1 / 60);
  assert.equal(g.measurements.length, count);
  assert.equal(g.stats().invalid, 0);
  assert.ok(g.stats().dynamic <= 11);
  return g.measurements[count - 1];
}
function shot(x: number, angle: number, power: number, seed = 7281) {
  const g = new ClassicGame(2, seed); g.bots = false;
  try { g.position = x; g.select(); g.angle = angle; g.select(); g.power = power; g.select(); return finish(g); }
  finally { g.dispose(); }
}
function summary(rows: ThrowMeasurement[]) {
  const bins = [0, 0, 0, 0, 0];
  for (const m of rows) bins[m.pins === 0 ? 0 : m.pins <= 3 ? 1 : m.pins <= 6 ? 2 : m.pins <= 9 ? 3 : 4]++;
  return { throws: rows.length, distribution: Object.fromEntries(['0', '1–3', '4–6', '7–9', '10'].map((b, i) => [b, bins[i]])), average: rows.reduce((s, m) => s + m.pins, 0) / rows.length, strikePercent: bins[4] * 100 / rows.length, gutterPercent: rows.filter(m => m.gutter).length * 100 / rows.length };
}
const dense: ThrowMeasurement[] = [];
for (const x of [-.56, -.4, -.2, 0, .2, .4, .56]) for (let a = -6.5; a <= 6.5; a += .5) for (const p of [35, 55, 78, 100]) dense.push(shot(x, a, p));
fs.writeFileSync(`${out}/dense.json`, JSON.stringify(dense, null, 2));
console.log('DENSE', summary(dense));
const bots: ThrowMeasurement[] = [], spares: ThrowMeasurement[] = [], random = seededRandom(20261005);
let opportunities = 0, conversions = 0;
for (let i = 0; i < 500; i++) {
  const g = new ClassicGame(2, 9157 + i * 31); g.autoHuman = true;
  try {
    const style = (['straight', 'angle', 'power'] as const)[i % 3];
    g.plan = botPlan(random, style, g.pins.map(p => p.body.translation()));
    const first = finish(g); bots.push(first);
    if (first.pins < 10) {
      opportunities++;
      while (g.phase !== 'position') g.advance(1 / 60);
      g.plan = botPlan(random, style, g.pins.map(p => p.body.translation()));
      const second = finish(g, 2); spares.push(second);
      if (first.pins + second.pins === 10) conversions++;
    }
  } finally { g.dispose(); }
  if ((i + 1) % 100 === 0) console.log('BOT PROGRESS', i + 1);
}
fs.writeFileSync(`${out}/bots-500.json`, JSON.stringify({ first: bots, second: spares }, null, 2));
const power = [35, 55, 78, 100].map(p => shot(0, 0, p));
const angle = Array.from({ length: 27 }, (_, i) => shot(0, -6.5 + i * .5, 78));
const position = [-.56, -.4, -.2, 0, .2, .4, .56].map(x => shot(x, Math.atan2(-x, C.headZ) * 180 / Math.PI, 78));
const repeatRecipes = [-.4, 0, .4].flatMap(x => [-.12, 0, .12].flatMap(entry => [55, 78, 100].map(p => {
  const samples = Array.from({ length: 10 }, (_, seed) => shot(x, Math.atan2(entry - x, C.headZ) * 180 / Math.PI, p, seed + 11));
  return { x, entry, power: p, ...summary(samples) };
})));
const matches = [];
for (const count of [2, 3] as const) for (let repeat = 0; repeat < 6; repeat++) {
  const g = new ClassicGame(count, 5221 + repeat); g.autoHuman = true;
  try {
    let maxBodies = 0, maxColliders = 0;
    for (let n = 0; n < 90000 && g.phase !== 'results'; n++) {
      g.advance(1 / 60);
      if (n % 30 === 0) { const s = g.stats(); assert.equal(s.invalid, 0); maxBodies = Math.max(maxBodies, s.bodies); maxColliders = Math.max(maxColliders, s.colliders); }
    }
    assert.equal(g.phase, 'results');
    assert.ok(g.score.totals.every(s => s >= 0 && s <= 30));
    assert.equal(g.score.cards.flat().length, count * 3);
    assert.ok(g.score.cards.flat().every(f => f.rolls.length === 2 || f.kind === 'strike'));
    matches.push({ count, repeat, totals: g.score.totals, winners: g.score.winners, rolls: g.measurements.map(({ seat, frame, roll, pins }) => ({ seat, frame, roll, pins })), maxBodies, maxColliders, final: g.stats() });
  } finally { g.dispose(); }
}
const result = { config: C, dense: summary(dense), competent: { ...summary(bots), spareOpportunities: opportunities, spareConversions: conversions, sparePercent: conversions * 100 / opportunities }, position, angle, power, repeatRecipes, matches };
fs.writeFileSync(`${out}/simulation-summary.json`, JSON.stringify(result, null, 2));
console.log('COMPETENT', result.competent);
console.log('REPEATED MATCHES', matches.length, 'PASS');
assert.ok(result.competent.strikePercent > 0 && result.competent.strikePercent < 70);
assert.ok(result.competent.gutterPercent > 0 && conversions > 0);
assert.ok(dense.some(m => m.pins > 0 && m.pins <= 3));
assert.ok(dense.filter(m => m.pins >= 7).length > 30);
assert.ok(dense.filter(m => m.gutter).every(m => m.impactTime === null && m.pins === 0), 'gutter balls must stay clear of pins');
console.log('ALL PHYSICS VALIDATIONS PASS');
