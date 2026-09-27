import test from 'node:test';
import assert from 'node:assert/strict';
import { BowlingEngine, engineVoice } from './audio';
import { defaultAudioSettings } from '../../audio/settings';

function fakeAudio() {
  const nodes: any[] = [];
  const param = () => ({ value: 0, targets: [] as number[], setTargetAtTime(v: number) { this.value = v; this.targets.push(v); } });
  const node = () => {
    const n = { frequency: param(), gain: param(), Q: param(), type: '', starts: 0, stops: 0, disconnected: false,
      connect() {}, disconnect() { this.disconnected = true; }, start() { this.starts++; }, stop() { this.stops++; }, setPeriodicWave() {} };
    nodes.push(n); return n;
  };
  const ctx = { state: 'suspended', currentTime: 0, sampleRate: 8000, destination: {},
    createGain: node, createBiquadFilter: node, createOscillator: node, createBufferSource: node,
    createPeriodicWave() { return {}; }, createBuffer(_channels: number, count: number) { return { getChannelData: () => new Float32Array(count) }; },
    async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; } };
  return { ctx, nodes, engine: new BowlingEngine(() => ctx as unknown as AudioContext) };
}

test('engine stays in a low band at 165 km/h and extreme inputs; coast retains road/wind', () => {
  let previous = 0;
  for (let kmh = 0; kmh <= 200; kmh++) {
    const v = engineVoice(kmh / 3.6, 1);
    assert.ok(v.bodyHz >= previous && v.bodyHz <= 118); previous = v.bodyHz;
    assert.ok(v.cutoffHz <= 600 && v.rumbleHz <= 49);
  }
  const loaded = engineVoice(165 / 3.6, 1), coast = engineVoice(165 / 3.6, 0);
  assert.ok(coast.bodyHz < loaded.bodyHz && coast.bodyGain < loaded.bodyGain);
  assert.equal(coast.windGain, loaded.windGain); assert.equal(coast.roadGain, loaded.roadGain);
  assert.equal(engineVoice(0, 0).windGain, 0);
  assert.ok(Object.values(engineVoice(NaN, Infinity)).every(Number.isFinite));
});

test('frames before unlock allocate nothing; gestures and consecutive throws reuse one graph', async () => {
  const { engine, nodes } = fakeAudio(), settings = defaultAudioSettings();
  engine.step(20, 1, true, settings); assert.equal(nodes.length, 0);
  engine.unlock(); const count = nodes.length;
  for (let throwIndex = 0; throwIndex < 8; throwIndex++) {
    engine.unlock(); engine.step(0, 0, true, settings); engine.step(46, 1, true, settings); engine.step(46, 0, false, settings);
  }
  assert.equal(nodes.length, count); assert.equal(nodes.reduce((sum, n) => sum + n.starts, 0), 4);
  engine.dispose(); await new Promise(resolve => setTimeout(resolve, 140));
});

test('eject, mute and blur fade out; blur cannot become audible until another gesture', async () => {
  const { engine, nodes } = fakeAudio(), settings = defaultAudioSettings(); engine.unlock();
  const output = nodes[0].gain;
  engine.step(46, 1, true, settings); assert.ok(output.value > 0 && output.value <= .05);
  engine.step(46, 1, false, settings); assert.equal(output.value, 0);
  engine.step(46, 1, true, { ...settings, muted: true }); assert.equal(output.value, 0);
  engine.silence(); engine.step(46, 1, true, settings); assert.equal(output.value, 0);
  engine.unlock(); engine.step(46, 1, true, settings); assert.ok(output.value > 0);
  engine.dispose(); await new Promise(resolve => setTimeout(resolve, 140));
});

test('dispose stops every source, disconnects every node, closes context and is repeatable', async () => {
  const { engine, nodes, ctx } = fakeAudio(); engine.unlock(); engine.dispose(); engine.dispose();
  assert.equal(nodes.filter(n => n.starts).every(n => n.stops === 1), true);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(nodes.every(n => n.disconnected)); assert.equal(ctx.state, 'closed');
});

test('unavailable WebAudio remains silent without breaking gameplay', () => {
  const engine = new BowlingEngine(() => { throw Error('unavailable'); });
  assert.doesNotThrow(() => { engine.unlock(); engine.step(46, 1, true, defaultAudioSettings()); engine.silence(); engine.dispose(); });
});
