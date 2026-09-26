import { clamp01, stereoPan, type FeedbackEvent, type SfxName } from "./events";
import {
  defaultAudioSettings,
  outputVolume,
  type AudioSettings,
} from "./settings";
import { SFX, type Recipe } from "./sfx";
import { SAMPLE_RATE, synthesize } from "./synth";
import { EventGate, VoicePool } from "./policy";

export const FALL_CAT_URL = "/party-lab/audio/fall-cat.wav";
interface Point3 {
  x: number;
  y: number;
  z: number;
}
/**
 * A positional cue's spatial feel (Saklambaç's whistle): distance falls off as the
 * inverse model from `refDistance` with `rolloff`; only `spatial` of the signal is panned (the
 * rest stays centred, so the direction reads roughly, never exactly); `muffle` (Hz) low-passes
 * it (a wall in the way), with `muffledGain` on top.
 */
export interface SpatialOptions {
  refDistance: number;
  rolloff: number;
  maxDistance: number;
  spatial: number;
  gain?: number;
  muffle?: number | null;
  muffledGain?: number;
}
/** Gain of the inverse distance model (what a PannerNode applies): 1 within `refDistance`. */
export function inverseDistanceGain(distance: number, { refDistance, rolloff, maxDistance }: SpatialOptions) {
  const d = Math.max(refDistance, Math.min(maxDistance, distance));
  return refDistance / (refDistance + rolloff * (d - refDistance));
}
const loadWav = async (url: string, signal: AbortSignal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error(`Audio load failed: ${response.status}`);
  return response.arrayBuffer();
};

/** One lazy context per Party Lab root, reused across local arena visits. */
export class AudioManager {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private fallBuffer: AudioBuffer | null = null;
  private fallLoad: Promise<void> | null = null;
  private fallRequest: AbortController | null = null;
  readonly voices = new VoicePool();
  private gate = new EventGate();
  private generation = 0;
  private background = false;
  settings: AudioSettings = defaultAudioSettings();
  readonly stats = { played: 0, dropped: 0, peakVoices: 0 };
  /** Where positional cues are heard from (set every frame by an arena that uses them). */
  private listener = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
  private spatialStops = new Map<() => void, string>();
  /** Cancel one presentation cue without cutting off whistles or other gameplay audio. */
  stopSpatial(key: string) {
    for (const [stop, name] of this.spatialStops) if (name === key) stop();
  }
  constructor(
    private readonly createContext = () => new AudioContext(),
    private readonly random = Math.random,
    private readonly loadAsset = loadWav
  ) {}
  get state() {
    return this.context?.state ?? "locked";
  }
  async unlock() {
    if (this.background) return false;
    const generation = this.generation;
    try {
      if (!this.context) {
        this.context = this.createContext();
        this.output = this.context.createGain();
        this.limiter = this.context.createDynamicsCompressor();
        this.limiter.threshold.value = -12;
        this.limiter.knee.value = 12;
        this.limiter.ratio.value = 5;
        this.output.connect(this.limiter);
        this.limiter.connect(this.context.destination);
        this.setSettings(this.settings);
      }
      // Start fetch/decode at the first gesture, before the arena countdown.
      // Do not delay UI audio or context resume while this one asset loads.
      void this.preload();
      if (this.context.state !== "running") await this.context.resume();
      return (
        generation === this.generation && this.context?.state === "running"
      );
    } catch {
      return false;
    }
  }
  preload(): Promise<void> {
    if (!this.context) return Promise.resolve();
    if (this.fallLoad) return this.fallLoad;
    const context = this.context;
    const generation = this.generation;
    const request = new AbortController();
    this.fallRequest = request;
    this.fallLoad = (async () => {
      try {
        const bytes = await this.loadAsset(FALL_CAT_URL, request.signal);
        if (request.signal.aborted) return;
        const buffer = await context.decodeAudioData(bytes);
        if (generation === this.generation && this.context === context)
          this.fallBuffer = buffer;
      } catch {
        // Missing/invalid WAV or disposal: procedural fall remains available.
      }
    })();
    return this.fallLoad;
  }
  setSettings(settings: AudioSettings) {
    this.settings = { ...settings };
    const volume = outputVolume(settings) * 0.65;
    if (this.output && this.context)
      this.output.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
    if (!volume) this.stopAll();
  }
  playSfx(event: FeedbackEvent): boolean {
    const context = this.context;
    if (
      !context ||
      context.state !== "running" ||
      this.background ||
      !this.output ||
      !outputVolume(this.settings)
    )
      return false;
    const recipe = SFX[event.name];
    if (!this.gate.allow(event, context.currentTime)) {
      this.stats.dropped++;
      return false;
    }
    let source: AudioBufferSourceNode | undefined,
      gain: GainNode | undefined,
      pan: StereoPannerNode | undefined;
    let id: number | null = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        source?.stop();
      } catch {
        /* Already ended. */
      }
      source?.disconnect();
      gain?.disconnect();
      pan?.disconnect();
      if (id !== null) this.voices.remove(id);
    };
    id = this.voices.add(recipe.priority, stop);
    if (id === null) {
      this.stats.dropped++;
      return false;
    }
    try {
      const variant = this.random() < 0.5 ? 0 : 1;
      const key = `${event.name}:${variant}`;
      const customFall = event.name === "fall" ? this.fallBuffer : null;
      let buffer = customFall ?? this.buffers.get(key);
      if (!buffer) {
        const data = synthesize(recipe, variant);
        buffer = context.createBuffer(1, data.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(data);
        this.buffers.set(key, buffer);
      }
      source = context.createBufferSource();
      source.buffer = buffer;
      const countdownPitch =
        event.name === "countdown" ? Math.pow(1.12, 3 - (event.step ?? 3)) : 1;
      source.playbackRate.value = customFall
        ? 1
        : (0.96 + this.random() * 0.08) * countdownPitch;
      gain = context.createGain();
      gain.gain.value =
        recipe.gain *
        (0.45 + 0.55 * clamp01(event.intensity ?? 0.65)) *
        (0.96 + this.random() * 0.08);
      source.connect(gain);
      if (
        typeof context.createStereoPanner === "function" &&
        event.x !== undefined &&
        !event.name.startsWith("ui")
      ) {
        pan = context.createStereoPanner();
        pan.pan.value = stereoPan(event.x);
        gain.connect(pan);
        pan.connect(this.output);
      } else gain.connect(this.output);
      source.onended = stop;
      source.start();
      this.stats.played++;
      this.stats.peakVoices = Math.max(
        this.stats.peakVoices,
        this.voices.voices.size
      );
      return true;
    } catch {
      stop();
      return false;
    }
  }
  /** The listener's pose for positional cues: where it is and which way it faces (a unit vector). */
  setListener(position: Point3, forward: Point3) {
    this.listener.position = { ...position };
    this.listener.forward = { ...forward };
    const listener = this.context?.listener;
    if (!listener) return;
    try {
      if (listener.positionX) {
        listener.positionX.value = position.x;
        listener.positionY.value = position.y;
        listener.positionZ.value = position.z;
        listener.forwardX.value = forward.x;
        listener.forwardY.value = forward.y;
        listener.forwardZ.value = forward.z;
        listener.upX.value = 0;
        listener.upY.value = 1;
        listener.upZ.value = 0;
      } else {
        listener.setPosition(position.x, position.y, position.z);
        listener.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
      }
    } catch {
      /* A context without a listener pose: the fallback pan still uses the stored one. */
    }
  }
  /**
   * A one-off positional cue at `at` (world metres) from a recipe outside the shared palette:
   * an equal-power PannerNode with the inverse distance model (no HRTF: left/right only, no
   * front/back or height cues) carries `spatial` of it, the rest plays centred. Without
   * PannerNode support it falls back to a stereo pan and the same distance gain from the
   * listener pose. Obeys mute, volume and the voice limit like every cue.
   */
  playSpatial(key: string, recipe: Recipe, at: Point3, options: SpatialOptions): boolean {
    const context = this.context;
    if (!context || context.state !== "running" || this.background || !this.output || !outputVolume(this.settings)) return false;
    const nodes: AudioNode[] = [];
    let source: AudioBufferSourceNode | undefined;
    let id: number | null = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.spatialStops.delete(stop);
      try {
        source?.stop();
      } catch {
        /* Already ended. */
      }
      for (const node of nodes) node.disconnect();
      if (id !== null) this.voices.remove(id);
    };
    id = this.voices.add(recipe.priority, stop);
    if (id === null) {
      this.stats.dropped++;
      return false;
    }
    this.spatialStops.set(stop, key);
    try {
      let buffer = this.buffers.get(key);
      if (!buffer) {
        const data = synthesize(recipe, 0);
        buffer = context.createBuffer(1, data.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(data);
        this.buffers.set(key, buffer);
      }
      source = context.createBufferSource();
      source.buffer = buffer;
      nodes.push(source);
      const gain = context.createGain();
      gain.gain.value = recipe.gain * (options.gain ?? 1) * (options.muffle ? options.muffledGain ?? 1 : 1);
      nodes.push(gain);
      let head: AudioNode = source;
      if (options.muffle && typeof context.createBiquadFilter === "function") {
        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = options.muffle;
        nodes.push(filter);
        source.connect(filter);
        head = filter;
      }
      head.connect(gain);
      const spatial = Math.max(0, Math.min(1, options.spatial));
      const panned = context.createGain(),
        centred = context.createGain();
      nodes.push(panned, centred);
      panned.gain.value = spatial;
      gain.connect(panned);
      gain.connect(centred);
      if (typeof context.createPanner === "function") {
        const panner = context.createPanner();
        panner.panningModel = "equalpower";
        panner.distanceModel = "inverse";
        panner.refDistance = options.refDistance;
        panner.rolloffFactor = options.rolloff;
        panner.maxDistance = options.maxDistance;
        if (panner.positionX) {
          panner.positionX.value = at.x;
          panner.positionY.value = at.y;
          panner.positionZ.value = at.z;
        } else panner.setPosition(at.x, at.y, at.z);
        nodes.push(panner);
        panned.connect(panner);
        panner.connect(this.output);
        // The centred share follows the same distance falloff (it is quieter far away too).
        const l = this.listener.position;
        centred.gain.value = (1 - spatial) * inverseDistanceGain(Math.hypot(at.x - l.x, at.y - l.y, at.z - l.z), options);
        centred.connect(this.output);
      } else {
        const { position: l, forward: f } = this.listener,
          dx = at.x - l.x,
          dz = at.z - l.z,
          d = Math.hypot(dx, dz) || 1,
          // Screen-right of the facing on the floor plane.
          side = (dx * -f.z + dz * f.x) / (d * (Math.hypot(f.x, f.z) || 1)),
          falloff = inverseDistanceGain(Math.hypot(dx, at.y - l.y, dz), options);
        panned.gain.value = spatial * falloff;
        centred.gain.value = (1 - spatial) * falloff;
        if (typeof context.createStereoPanner === "function") {
          const pan = context.createStereoPanner();
          pan.pan.value = Math.max(-1, Math.min(1, side));
          nodes.push(pan);
          panned.connect(pan);
          pan.connect(this.output);
        } else panned.connect(this.output);
        centred.connect(this.output);
      }
      source.onended = stop;
      source.start();
      this.stats.played++;
      this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.voices.size);
      return true;
    } catch {
      stop();
      return false;
    }
  }
  async playUi(name: SfxName = "uiClick") {
    return (await this.unlock()) ? this.playSfx({ name }) : false;
  }
  stopAll() {
    this.voices.clear();
    this.gate.clear();
  }
  setBackground(hidden: boolean) {
    this.background = hidden;
    if (hidden) {
      this.stopAll();
      void this.context?.suspend().catch(() => {});
    }
    // Resume only on a later user gesture, never replay a backlog.
  }
  dispose() {
    this.generation++;
    this.fallRequest?.abort();
    this.fallRequest = null;
    this.fallLoad = null;
    this.fallBuffer = null;
    this.stopAll();
    this.buffers.clear();
    this.output?.disconnect();
    this.limiter?.disconnect();
    const context = this.context;
    this.context = null;
    this.output = null;
    this.limiter = null;
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
  }
}
