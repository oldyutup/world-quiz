import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SFX_NAMES,
  hitSound,
  impactLevel,
  collisionStrength,
  stereoPan,
} from "./events";
import {
  AUDIO_KEY,
  clampVolume,
  defaultAudioSettings,
  deserializeAudio,
  loadAudioSettings,
  outputVolume,
  saveAudioSettings,
  serializeAudio,
} from "./settings";
import { SFX } from "./sfx";
import { synthesize } from "./synth";
import {
  CollisionGate,
  EventGate,
  MAX_VOICES,
  VoicePool,
  collisionSound,
  type CollisionCandidate,
} from "./policy";
import { AudioManager, FALL_CAT_URL } from "./AudioManager";
import { CameraFeel } from "./feel";

test("all semantic sounds have original bounded, finite, faded procedural waveforms", () => {
  for (const name of SFX_NAMES) {
    const a = synthesize(SFX[name]),
      b = synthesize(SFX[name], 1);
    assert.ok(a.length > 100 && a.length < 35000);
    assert.equal(a[0], 0);
    assert.ok(Math.abs(a[a.length - 1]) < 0.001);
    assert.ok(a.every((n) => Number.isFinite(n) && Math.abs(n) < 1));
    assert.ok(a.some((n) => Math.abs(n) > 0.02));
    assert.notDeepEqual(a, b);
    assert.deepEqual(a, synthesize(SFX[name]));
  }
  assert.ok(SFX.winner.duration >= 1 && SFX.winner.duration <= 2);
});
test("volume clamp, effective gain, mute and zero settings", () => {
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(120), 100);
  assert.equal(clampVolume(NaN), 0);
  assert.equal(outputVolume(defaultAudioSettings()), 0.68);
  assert.equal(outputVolume({ ...defaultAudioSettings(), muted: true }), 0);
  assert.equal(outputVolume({ ...defaultAudioSettings(), sfx: 0 }), 0);
});
test("versioned audio preferences survive reload and malformed data falls back", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
  const settings = { master: 37, sfx: 64, muted: true, cameraShake: false };
  assert.ok(saveAudioSettings(settings, store));
  assert.equal(map.get(AUDIO_KEY), serializeAudio(settings));
  assert.deepEqual(loadAudioSettings(store), settings);
  for (const data of [
    "{",
    "null",
    "[]",
    '{"version":2}',
    serializeAudio({ ...settings, master: -5 }),
    JSON.stringify({ version: 1, settings: { ...settings, muted: "yes" } }),
  ])
    assert.deepEqual(deserializeAudio(data), defaultAudioSettings());
  const blocked = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  };
  assert.deepEqual(loadAudioSettings(blocked), defaultAudioSettings());
  assert.equal(saveAudioSettings(settings, blocked), false);
});
test("impact intensity and head/body/limb distinctions reflect physical input", () => {
  assert.equal(impactLevel(collisionStrength(1.2, 0.05)), "LIGHT");
  assert.equal(impactLevel(collisionStrength(3.5, 0.5)), "MEDIUM");
  assert.equal(impactLevel(collisionStrength(7, 2)), "HEAVY");
  assert.equal(hitSound("head"), "headHit");
  assert.equal(hitSound("pelvis"), "bodyHit");
  assert.equal(hitSound("torso"), "bodyHit");
  assert.equal(hitSound("leftHand"), "limbHit");
  assert.equal(stereoPan(0), 0);
  assert.equal(stereoPan(100), 0.65);
  assert.equal(stereoPan(-100), -0.65);
});
const candidate = (
  overrides: Partial<CollisionCandidate> = {}
): CollisionCandidate => ({
  pair: "1:2",
  group: "0:floor",
  actor: 0,
  part: "torso",
  x: 0,
  floor: true,
  speed: 5,
  impulse: 1,
  intensity: 0.6,
  ...overrides,
});
test("contact cooldowns, thresholds and collapse aggregation suppress nine-body chatter", () => {
  const gate = new CollisionGate();
  assert.equal(gate.select([candidate({ speed: 0.2 })], 0).length, 0);
  assert.equal(gate.select([candidate({ impulse: 0.01 })], 0).length, 0);
  const collapse = Array.from({ length: 9 }, (_, i) =>
    candidate({ pair: `${i}:floor`, part: i === 2 ? "head" : "torso" })
  );
  assert.equal(gate.select(collapse, 0).length, 2);
  assert.equal(gate.select(collapse, 0.1).length, 0);
  assert.equal(gate.select(collapse, 0.25).length, 2);
  gate.clear();
  assert.equal(gate.select([candidate()], 0).length, 1);
  assert.equal(collisionSound(candidate()), "floorFlop");
  assert.equal(collisionSound(candidate({ part: "head" })), "headHit");
  assert.equal(
    collisionSound(candidate({ floor: false, intensity: 1 })),
    "heavyBump"
  );
});
test("semantic duplicates are throttled without swallowing separate countdown numbers", () => {
  const gate = new EventGate();
  assert.equal(gate.allow({ name: "grab", actor: 0 }, 0), true);
  assert.equal(gate.allow({ name: "grab", actor: 0 }, 0.01), false);
  assert.equal(gate.allow({ name: "countdown", step: 3 }, 0), true);
  assert.equal(gate.allow({ name: "countdown", step: 2 }, 1), true);
  gate.clear();
  assert.equal(gate.allow({ name: "grab", actor: 0 }, 0), true);
});
test("16 voice cap drops low priority and evicts lowest for KO/jingles; cleanup stops all", () => {
  const pool = new VoicePool();
  let stopped = 0;
  for (let i = 0; i < MAX_VOICES; i++)
    assert.notEqual(
      pool.add(0, () => stopped++),
      null
    );
  assert.equal(
    pool.add(0, () => stopped++),
    null
  );
  assert.notEqual(
    pool.add(2, () => stopped++),
    null
  );
  assert.equal(stopped, 1);
  assert.equal(pool.voices.size, MAX_VOICES);
  pool.clear();
  assert.equal(stopped, MAX_VOICES + 1);
  assert.equal(pool.voices.size, 0);
  pool.clear();
  assert.equal(stopped, MAX_VOICES + 1);
});
class Param {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
  }
}
class Node {
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}
class Source extends Node {
  buffer: unknown;
  playbackRate = new Param();
  onended?: () => void;
  stopped = false;
  start() {}
  stop() {
    this.stopped = true;
  }
}
class FakeContext {
  state = "suspended";
  currentTime = 0;
  destination = new Node();
  sources: Source[] = [];
  gains: (Node & { gain: Param })[] = [];
  resumes = 0;
  closes = 0;
  decodes = 0;
  decoded = { sample: "custom WAV" } as unknown as AudioBuffer;
  async decodeAudioData(_bytes: ArrayBuffer) {
    this.decodes++;
    return this.decoded;
  }
  createGain() {
    const n = Object.assign(new Node(), { gain: new Param() });
    this.gains.push(n);
    return n;
  }
  createDynamicsCompressor() {
    return Object.assign(new Node(), {
      threshold: new Param(),
      knee: new Param(),
      ratio: new Param(),
    });
  }
  createStereoPanner() {
    return Object.assign(new Node(), { pan: new Param() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  async resume() {
    this.resumes++;
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.closes++;
    this.state = "closed";
  }
}
test("lazy context, concurrent unlock, variation, mute, background and reusable dispose", async () => {
  let created = 0;
  const contexts: FakeContext[] = [];
  const manager = new AudioManager(
    () => {
      created++;
      const ctx = new FakeContext();
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    () => 0.75
  );
  assert.equal(manager.playSfx({ name: "bodyHit" }), false);
  assert.equal(created, 0);
  await Promise.all([manager.unlock(), manager.unlock()]);
  assert.equal(created, 1);
  assert.ok(manager.playSfx({ name: "bodyHit", intensity: 0.8, x: -4 }));
  assert.ok(
    contexts[0].sources[0].playbackRate.value >= 0.96 &&
      contexts[0].sources[0].playbackRate.value <= 1.04
  );
  manager.setSettings({ ...defaultAudioSettings(), muted: true });
  assert.ok(contexts[0].sources.every((s) => s.stopped && s.disconnected));
  assert.equal(manager.voices.voices.size, 0);
  assert.equal(manager.playSfx({ name: "winner" }), false);
  assert.equal(await manager.playUi(), false);
  manager.setSettings(defaultAudioSettings());
  manager.setBackground(true);
  assert.equal(await manager.unlock(), false);
  manager.setBackground(false);
  await manager.unlock();
  assert.equal(created, 1);
  assert.equal(await manager.playUi(), true);
  contexts[0].sources[contexts[0].sources.length - 1].onended!();
  assert.equal(manager.voices.voices.size, 0);
  manager.dispose();
  manager.dispose();
  assert.equal(contexts[0].closes, 1);
  await manager.unlock();
  assert.equal(created, 2);
  manager.dispose();
});
test("unavailable audio and blocked resume fail silently without a backlog", async () => {
  const unavailable = new AudioManager(() => {
    throw Error("unavailable");
  });
  assert.equal(await unavailable.unlock(), false);
  assert.equal(unavailable.playSfx({ name: "winner" }), false);
  unavailable.dispose();
  const ctx = new FakeContext();
  ctx.resume = async () => {
    throw Error("gesture required");
  };
  const manager = new AudioManager(() => ctx as unknown as AudioContext);
  assert.equal(await manager.unlock(), false);
  assert.equal(manager.playSfx({ name: "headHit" }), false);
  assert.equal(ctx.sources.length, 0);
  manager.dispose();
});
test("camera feedback is local/heavy only, capped and disabled by preference/reduced motion", () => {
  const feel = new CameraFeel();
  feel.trigger({ name: "headHit", actor: 1, target: 2, intensity: 1 });
  assert.deepEqual(feel.step(0.01, true), [0, 0]);
  feel.trigger({ name: "bodyHit", actor: 0, intensity: 0.4 });
  assert.deepEqual(feel.step(0.01, true), [0, 0]);
  feel.trigger({ name: "knockout", actor: 0, intensity: 1 });
  const offset = feel.step(0.01, true);
  assert.ok(offset.some((n) => n !== 0));
  assert.ok(offset.every((n) => Math.abs(n) <= 0.035));
  assert.deepEqual(feel.step(0.01, false), [0, 0]);
  feel.trigger({ name: "knockout", actor: 0, intensity: 1 });
  assert.deepEqual(feel.step(0.2, true), [0, 0]);
});

test("fall WAV preloads once, replaces procedural fall and allows simultaneous human/bot eliminations", async () => {
  const ctx = new FakeContext();
  let loads = 0;
  const manager = new AudioManager(
    () => ctx as unknown as AudioContext,
    () => 0.5,
    async (url) => {
      assert.equal(url, FALL_CAT_URL);
      loads++;
      return new ArrayBuffer(8);
    }
  );
  await Promise.all([manager.unlock(), manager.unlock()]);
  await manager.preload();
  assert.equal(loads, 1);
  assert.equal(ctx.decodes, 1);
  for (const actor of [0, 1, 2]) {
    assert.equal(manager.playSfx({ name: "fall", actor }), true);
    assert.equal(manager.playSfx({ name: "fall", actor }), false);
  }
  assert.equal(
    ctx.sources.length,
    3,
    "one source per elimination, no procedural layer"
  );
  assert.ok(
    ctx.sources.every(
      (source) =>
        source.buffer === ctx.decoded && source.playbackRate.value === 1
    )
  );
  for (const name of ["knockout", "floorFlop", "jump", "landing"] as const) {
    assert.ok(manager.playSfx({ name }));
    assert.notEqual(ctx.sources[ctx.sources.length - 1].buffer, ctx.decoded);
  }
  ctx.currentTime = 10;
  assert.ok(manager.playSfx({ name: "fall", actor: 0 }), "eligible next round");
  await manager.unlock();
  assert.equal(loads, 1);
  manager.dispose();
});

test("custom fall uses existing master/SFX gain, mute and voice priority", async () => {
  const ctx = new FakeContext();
  const manager = new AudioManager(
    () => ctx as unknown as AudioContext,
    () => 0.5,
    async () => new ArrayBuffer(8)
  );
  await manager.unlock();
  await manager.preload();
  manager.setSettings({ ...defaultAudioSettings(), master: 50, sfx: 40 });
  assert.equal(ctx.gains[0].gain.value, 0.5 * 0.4 * 0.65);
  let evicted = 0;
  for (let i = 0; i < MAX_VOICES; i++) manager.voices.add(0, () => evicted++);
  assert.ok(manager.playSfx({ name: "fall", actor: 0 }));
  assert.equal(evicted, 1);
  assert.equal(manager.voices.voices.size, MAX_VOICES);
  assert.equal(ctx.sources[0].buffer, ctx.decoded);
  manager.setSettings({ ...defaultAudioSettings(), muted: true });
  assert.ok(ctx.sources[0].stopped);
  assert.equal(manager.playSfx({ name: "fall", actor: 1 }), false);
  manager.setSettings({ ...defaultAudioSettings(), sfx: 0 });
  assert.equal(manager.playSfx({ name: "fall", actor: 1 }), false);
  manager.dispose();
});

test("fall fetch/decode failures use a single procedural fallback without retry storms", async () => {
  for (const failure of ["load", "decode"]) {
    const ctx = new FakeContext();
    if (failure === "decode")
      ctx.decodeAudioData = async () => {
        throw Error("invalid WAV");
      };
    let loads = 0;
    const manager = new AudioManager(
      () => ctx as unknown as AudioContext,
      () => 0.5,
      async () => {
        loads++;
        if (failure === "load") throw Error("missing asset");
        return new ArrayBuffer(8);
      }
    );
    await manager.unlock();
    await manager.preload();
    await manager.unlock();
    assert.equal(loads, 1);
    assert.ok(manager.playSfx({ name: "fall", actor: 0 }));
    assert.equal(ctx.sources.length, 1);
    assert.notEqual(ctx.sources[0].buffer, ctx.decoded);
    manager.dispose();
  }
});

test("a fall during loading plays fallback immediately and never replays after decode", async () => {
  const ctx = new FakeContext();
  let finish!: (bytes: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve;
  });
  const manager = new AudioManager(
    () => ctx as unknown as AudioContext,
    () => 0.5,
    () => pending
  );
  await manager.unlock();
  assert.ok(manager.playSfx({ name: "fall", actor: 0 }));
  assert.notEqual(ctx.sources[0].buffer, ctx.decoded);
  finish(new ArrayBuffer(8));
  await manager.preload();
  assert.equal(ctx.sources.length, 1);
  assert.ok(manager.playSfx({ name: "fall", actor: 1 }));
  assert.equal(ctx.sources[1].buffer, ctx.decoded);
  manager.dispose();
});

test("disposal aborts preload and discards a stale decode across context recreation", async () => {
  const old = new FakeContext(),
    fresh = new FakeContext();
  let finish!: (buffer: AudioBuffer) => void;
  old.decodeAudioData = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let signal!: AbortSignal,
    creates = 0,
    loads = 0;
  const manager = new AudioManager(
    () => (creates++ ? fresh : old) as unknown as AudioContext,
    () => 0.5,
    async (_url, requestSignal) => {
      signal = requestSignal;
      loads++;
      return new ArrayBuffer(8);
    }
  );
  await manager.unlock();
  const pending = manager.preload();
  manager.dispose();
  assert.equal(signal.aborted, true);
  await manager.unlock();
  await manager.preload();
  finish(old.decoded);
  await pending;
  assert.equal(loads, 2);
  assert.ok(manager.playSfx({ name: "fall", actor: 0 }));
  assert.equal(fresh.sources[0].buffer, fresh.decoded);
  manager.dispose();
});
