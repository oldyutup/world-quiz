import { clamp01, stereoPan, type FeedbackEvent, type SfxName } from "./events";
import {
  defaultAudioSettings,
  outputVolume,
  type AudioSettings,
} from "./settings";
import { SFX } from "./sfx";
import { SAMPLE_RATE, synthesize } from "./synth";
import { EventGate, VoicePool } from "./policy";

export const FALL_CAT_URL = "/party-lab/audio/fall-cat.wav";
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
