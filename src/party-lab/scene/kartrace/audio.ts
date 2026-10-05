import type { AudioSettings } from '../../audio/settings';
import { outputVolume } from '../../audio/settings';

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Audio-only ranges: actual horizontal m/s, independent of simulation time scale. */
export function engineVoice(speed: number, throttle: number) {
  const travel = unit(speed / (110 / 3.6)), load = unit(throttle), rpm = Math.pow(travel, .7);
  return {
    bodyHz: 42 + rpm * 62 + load * 14,
    rumbleHz: 26 + rpm * 23,
    pulseHz: 14 + rpm * 17,
    cutoffHz: 320 + rpm * 180 + load * 100,
    bodyGain: .24 + rpm * .07 + load * .09,
    roadGain: .035 * travel,
    windGain: .11 * Math.pow(Math.max(0, (travel - .5) / .5), 2),
  };
}

interface EngineGraph {
  ctx: AudioContext;
  body: OscillatorNode;
  rumble: OscillatorNode;
  pulse: OscillatorNode;
  bodyFilter: BiquadFilterNode;
  bodyGain: GainNode;
  roadGain: GainNode;
  windGain: GainNode;
  output: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/** One gesture-unlocked graph per local Race visit; never allocated per throw/frame. */
export class RaceEngine {
  private graph: EngineGraph | null = null;
  private audible = false;
  constructor(private readonly createContext = () => new AudioContext()) {}

  unlock() {
    try {
      if (!this.graph) this.graph = this.createGraph();
      this.audible = true;
      if (this.graph.ctx.state === 'suspended') void this.graph.ctx.resume().catch(() => {});
    } catch {
      // Audio availability must never interrupt a throw.
    }
  }

  private createGraph(): EngineGraph {
    const ctx = this.createContext();
    const nodes: AudioNode[] = [], sources: AudioScheduledSourceNode[] = [];
    const gain = (value: number) => { const n = ctx.createGain(); n.gain.value = value; nodes.push(n); return n; };
    const filter = (type: BiquadFilterType, hz: number) => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = hz; n.Q.value = .5; nodes.push(n); return n;
    };
    const oscillator = (hz: number) => {
      const n = ctx.createOscillator(); n.type = 'sine'; n.frequency.value = hz; nodes.push(n); sources.push(n); return n;
    };
    try {
      const output = gain(0), safetyFilter = filter('lowpass', 900);
      safetyFilter.connect(output); output.connect(ctx.destination);
      const body = oscillator(42), bodyFilter = filter('lowpass', 320), bodyGain = gain(.24);
      // Six declining harmonics: rounded body without a sawtooth's treble tail.
      body.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(7), new Float32Array([0, 1, .45, .22, .1, .045, .02])));
      const pulse = oscillator(14), pulseDepth = gain(.14), pulseEnvelope = gain(1);
      pulse.connect(pulseDepth); pulseDepth.connect(pulseEnvelope.gain);
      body.connect(bodyFilter); bodyFilter.connect(bodyGain); bodyGain.connect(pulseEnvelope); pulseEnvelope.connect(safetyFilter);
      const rumble = oscillator(26), rumbleGain = gain(.085);
      rumble.connect(rumbleGain); rumbleGain.connect(safetyFilter);

      // Tiny two-second deterministic noise loop; soft road/wind bands, no broadband hiss.
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), data = buffer.getChannelData(0);
      let seed = 7281;
      for (let i = 0; i < data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = seed / 0x80000000 - 1; }
      const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true; nodes.push(noise); sources.push(noise);
      const roadLow = filter('lowpass', 240), roadHigh = filter('highpass', 65), roadGain = gain(0);
      noise.connect(roadLow); roadLow.connect(roadHigh); roadHigh.connect(roadGain); roadGain.connect(safetyFilter);
      const windLow = filter('lowpass', 650), windHigh = filter('highpass', 180), windGain = gain(0);
      noise.connect(windLow); windLow.connect(windHigh); windHigh.connect(windGain); windGain.connect(safetyFilter);
      for (const source of sources) source.start();
      return { ctx, body, rumble, pulse, bodyFilter, bodyGain, roadGain, windGain, output, sources, nodes };
    } catch (error) {
      for (const node of nodes) node.disconnect();
      void ctx.close().catch(() => {});
      throw error;
    }
  }

  step(speed: number, throttle: number, active: boolean, settings: AudioSettings, grass = false) {
    const g = this.graph; if (!g) return;
    const voice = engineVoice(speed, throttle), now = g.ctx.currentTime;
    const target = (param: AudioParam, value: number, smoothing = .18) => param.setTargetAtTime(value, now, smoothing);
    target(g.body.frequency, voice.bodyHz);
    target(g.rumble.frequency, voice.rumbleHz);
    target(g.pulse.frequency, voice.pulseHz);
    target(g.bodyFilter.frequency, voice.cutoffHz);
    target(g.bodyGain.gain, voice.bodyGain, .12);
    target(g.roadGain.gain, voice.roadGain + (grass ? .065 * Math.min(1, speed / 15) : 0), .22);
    target(g.windGain.gain, voice.windGain, .22);
    // Headroom for shared cat/impact/UI audio. Pause fades ~95% in 75 ms.
    target(g.output.gain, active && this.audible ? outputVolume(settings) * .05 : 0, active ? .08 : .025);
  }

  silence() {
    this.audible = false; // Focus/visibility recovery requires another real gesture.
    const g = this.graph;
    if (g) g.output.gain.setTargetAtTime(0, g.ctx.currentTime, .015);
  }

  dispose() {
    this.silence();
    const g = this.graph; this.graph = null;
    if (!g) return;
    // Fade before stopping, including keyed restarts; capture this graph, not a later unlock.
    for (const source of g.sources) source.stop(g.ctx.currentTime + .1);
    setTimeout(() => {
      for (const node of g.nodes) node.disconnect();
      void g.ctx.close().catch(() => {});
    }, 120);
  }
}
