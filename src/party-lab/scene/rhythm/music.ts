import type { AudioManager } from "../../audio/AudioManager";
import type { RhythmStyle, Song, SongNote } from "../../../../shared/party-lab/simulation/rhythm/song";
import { arrange, type BandEvent } from "./arrangement";

/** MIDI note → Hz. */
export const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** How far ahead the band is scheduled, s (rAF can stall a little; the clock of the context cannot). */
const LOOKAHEAD = 0.25;
/**
 * Keeping the band on the game clock: a drift under `TRACK` s is followed slowly, up to `JUMP` s
 * the next notes simply use the new clock, beyond it (a pause, a hidden page) everything queued
 * is dropped and the band starts again where the song is.
 */
const TRACK = 0.008;
const JUMP = 0.15;
const MASTER = 0.55;

/**
 * Where game time sits on the audio clock: the context time whose sound is heard when the game
 * clock reads 0. `getOutputTimestamp` says which context time leaves the speakers at which
 * performance.now() (output latency included), so a note scheduled here is HEARD when the
 * screen shows it; without it, the current time less the reported latency.
 */
export function audioOffset(context: Pick<AudioContext, "currentTime"> & Partial<Pick<AudioContext, "getOutputTimestamp" | "baseLatency" | "outputLatency">>, gameNow: number, wallNow: number) {
  const ts = context.getOutputTimestamp?.();
  if (ts && (ts.contextTime ?? 0) > 0 && (ts.performanceTime ?? 0) > 0) return ts.contextTime! + (wallNow - gameNow - ts.performanceTime!) / 1000;
  // A note scheduled at currentTime is heard `latency` later: what is heard now was scheduled that long ago.
  const latency = (context.outputLatency || 0) + (context.baseLatency || 0);
  return context.currentTime - latency - gameNow / 1000;
}

interface Pending {
  start: number;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
}

/**
 * Ritim Ustası's music in the browser, all synthesized (no files): the song's backing band on a
 * look-ahead schedule tied to the game clock, and the melody notes, played the moment this
 * player hits them. Everything goes through the Party Lab output (volume, mute, limiter); while
 * audio is locked or the page hidden nothing is scheduled, and once it runs the band joins the
 * song where it is.
 */
export class RhythmMusic {
  private song: Song | null = null;
  private events: BandEvent[] = [];
  private next = 0;
  private offset: number | null = null;
  private context: AudioContext | null = null;
  private bus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crackle: AudioBuffer | null = null;
  private waves = new Map<string, PeriodicWave>();
  private pending: Pending[] = [];
  private crackleSource: AudioBufferSourceNode | null = null;
  constructor(private readonly audio: AudioManager) {}
  /** A new song (or none): the old one's scheduled notes are dropped. */
  setSong(song: Song | null) {
    if (song === this.song) return;
    this.cancel();
    this.song = song;
    this.events = song ? arrange(song) : [];
    this.next = 0;
  }
  get style(): RhythmStyle | null {
    return this.song?.style ?? null;
  }
  private ensure(context: AudioContext, output: AudioNode) {
    if (this.context === context && this.bus) return this.bus;
    this.cancel();
    this.bus?.disconnect();
    this.context = context;
    this.bus = context.createGain();
    this.bus.gain.value = MASTER;
    this.bus.connect(output);
    this.waves.clear();
    const length = context.sampleRate;
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 0x2f6a1c3d;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 0x80000000 - 1;
    }
    // Vinyl: a soft hiss with sparse ticks, two seconds looped.
    this.crackle = context.createBuffer(1, length * 2, context.sampleRate);
    const vinyl = this.crackle.getChannelData(0);
    for (let i = 0; i < vinyl.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const r = seed / 0x100000000;
      vinyl[i] = (r - 0.5) * 0.05 + (r < 0.0006 ? (r < 0.0003 ? 0.9 : -0.7) : 0);
    }
    return this.bus;
  }
  /** A pulse wave of `duty` (the chiptune sound), built once per context. */
  private pulse(duty: number) {
    const key = `pulse:${duty}`;
    let wave = this.waves.get(key);
    if (!wave && this.context) {
      const n = 32,
        real = new Float32Array(n),
        imag = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        real[k] = Math.sin(2 * Math.PI * k * duty) / (k * Math.PI);
        imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (k * Math.PI);
      }
      wave = this.context.createPeriodicWave(real, imag);
      this.waves.set(key, wave);
    }
    return wave!;
  }
  /** Drops every scheduled note that has not started yet. */
  private cancel() {
    const now = this.context?.currentTime ?? Infinity;
    for (const p of this.pending)
      if (p.start > now) {
        for (const s of p.sources)
          try {
            s.stop();
          } catch {
            /* Not started. */
          }
        for (const n of p.nodes) n.disconnect();
      }
    this.pending = [];
    this.offset = null;
    if (this.crackleSource) {
      try {
        this.crackleSource.stop();
      } catch {
        /* Already stopped. */
      }
      this.crackleSource.disconnect();
      this.crackleSource = null;
    }
  }
  /**
   * Called every frame: `gameNow` is the game clock (ms after BAŞLA) at `wallNow`
   * (performance.now()); `running` false (countdown, menu pause, results) holds the band.
   */
  update(gameNow: number, wallNow: number, running: boolean) {
    const bus = this.audio.musicBus();
    if (!bus || !this.song || !running) {
      if (this.pending.length || this.offset !== null) this.cancel();
      return;
    }
    const out = this.ensure(bus.context, bus.output),
      context = bus.context;
    const estimate = audioOffset(context, gameNow, wallNow),
      drift = this.offset === null ? Infinity : Math.abs(estimate - this.offset);
    if (drift > JUMP) {
      // (Re)start: nothing old stays queued; the band picks up where the song is.
      this.cancel();
      this.offset = estimate;
      const from = gameNow + 15;
      this.next = this.events.findIndex((e) => e.t >= from);
      if (this.next < 0) this.next = this.events.length;
      if (this.song.style === "lofi" && this.crackle && gameNow < this.song.endAt + 1500) {
        const source = context.createBufferSource(),
          gain = context.createGain();
        source.buffer = this.crackle;
        source.loop = true;
        gain.gain.value = 0.22;
        source.connect(gain).connect(out);
        source.start();
        source.stop(this.offset + (this.song.endAt + 2500) / 1000);
        source.onended = () => gain.disconnect();
        this.crackleSource = source;
      }
    } else if (drift > TRACK) this.offset = estimate;
    else this.offset = this.offset! + (estimate - this.offset!) * 0.05;
    const horizon = context.currentTime + LOOKAHEAD;
    while (this.next < this.events.length) {
      const e = this.events[this.next],
        start = this.offset! + e.t / 1000;
      if (start > horizon) break;
      this.next++;
      if (start < context.currentTime + 0.002) continue;
      this.play(e, start, out);
    }
    this.pending = this.pending.filter((p) => p.start > context.currentTime - 0.05);
  }
  /** A melody note hit by this player: it sounds now, until its written end (`left` ms from now). */
  playMelody(note: SongNote, left: number) {
    const bus = this.audio.musicBus();
    if (!bus || !this.song) return false;
    const out = this.ensure(bus.context, bus.output);
    const start = bus.context.currentTime + 0.003,
      dur = Math.max(0.09, Math.min(1.8, left / 1000));
    this.lead(this.song.style, note.pitch, start, dur, out);
    return true;
  }
  stop() {
    this.cancel();
  }
  dispose() {
    this.cancel();
    this.bus?.disconnect();
    this.bus = null;
    this.context = null;
    this.song = null;
  }

  // ── Instruments ─────────────────────────────────────────────────────────────────────────
  private voice(start: number, end: number) {
    const p: Pending = { start, nodes: [], sources: [] };
    this.pending.push(p);
    const c = this.context!;
    return {
      gain: (value = 0) => {
        const g = c.createGain();
        g.gain.value = value;
        p.nodes.push(g);
        return g;
      },
      filter: (type: BiquadFilterType, frequency: number, q = 0.7) => {
        const f = c.createBiquadFilter();
        f.type = type;
        f.frequency.value = frequency;
        f.Q.value = q;
        p.nodes.push(f);
        return f;
      },
      osc: (type: OscillatorType | PeriodicWave, frequency: number, detune = 0) => {
        const o = c.createOscillator();
        if (typeof type === "string") o.type = type as OscillatorType;
        else o.setPeriodicWave(type);
        o.frequency.value = frequency;
        o.detune.value = detune;
        o.start(start);
        o.stop(end + 0.05);
        p.nodes.push(o);
        p.sources.push(o);
        o.onended = () => p.nodes.forEach((n) => n.disconnect());
        return o;
      },
      noise: (offset = 0) => {
        const s = c.createBufferSource();
        s.buffer = this.noise;
        s.start(start, offset);
        s.stop(end + 0.05);
        p.nodes.push(s);
        p.sources.push(s);
        s.onended = () => p.nodes.forEach((n) => n.disconnect());
        return s;
      },
    };
  }
  /** A decaying envelope on `g`: up to `peak` in `attack` s, down to silence by `end`. */
  /**
   * An envelope on `g`: up to `peak` in `attack` s; then with no `sustain` an exponential fall
   * to silence at `end`, else a short fall to `peak × sustain`, held, and a quick release by `end`.
   */
  private static env(g: GainNode, start: number, peak: number, attack: number, end: number, sustain = 0) {
    const a = g.gain,
      top = start + Math.min(attack, (end - start) * 0.5);
    a.setValueAtTime(0.0001, start);
    a.linearRampToValueAtTime(peak, top);
    if (sustain <= 0) {
      a.exponentialRampToValueAtTime(0.0001, end);
      return;
    }
    const release = Math.min(0.05, (end - top) * 0.4),
      settled = Math.min(end - release, top + 0.09);
    a.linearRampToValueAtTime(peak * sustain, settled);
    a.setValueAtTime(peak * sustain, end - release);
    a.linearRampToValueAtTime(0.0001, end);
  }
  private play(e: BandEvent, start: number, out: AudioNode) {
    const style = this.song!.style,
      dur = e.dur / 1000,
      v = e.vel;
    const env = RhythmMusic.env;
    switch (e.voice) {
      case "kick": {
        const end = start + (style === "lofi" ? 0.3 : 0.38);
        const n = this.voice(start, end),
          o = n.osc(style === "chiptune" ? "triangle" : "sine", 150),
          g = n.gain();
        o.frequency.setValueAtTime(style === "chiptune" ? 200 : 155, start);
        o.frequency.exponentialRampToValueAtTime(style === "lofi" ? 50 : 44, start + (style === "chiptune" ? 0.07 : 0.11));
        env(g, start, (style === "lofi" ? 0.62 : 0.85) * v, 0.003, end);
        o.connect(g).connect(out);
        break;
      }
      case "snare": {
        const end = start + (style === "chiptune" ? 0.12 : 0.2);
        const n = this.voice(start, end),
          s = n.noise(0.2),
          f = style === "lofi" ? n.filter("lowpass", 3200) : n.filter(style === "chiptune" ? "highpass" : "bandpass", style === "chiptune" ? 1200 : 1900, 0.8),
          g = n.gain();
        env(g, start, (style === "lofi" ? 0.24 : 0.32) * v, 0.002, end);
        s.connect(f).connect(g).connect(out);
        const body = n.osc("triangle", 190),
          bg = n.gain();
        env(bg, start, 0.22 * v, 0.002, start + 0.08);
        body.connect(bg).connect(out);
        break;
      }
      case "clap": {
        const end = start + 0.2;
        const n = this.voice(start, end),
          s = n.noise(0.4),
          f = n.filter("bandpass", 1250, 1.1),
          g = n.gain();
        const a = g.gain;
        a.setValueAtTime(0.0001, start);
        for (const k of [0, 0.011, 0.022]) {
          a.setValueAtTime(0.36 * v, start + k);
          a.exponentialRampToValueAtTime(0.05 * v, start + k + 0.009);
        }
        a.setValueAtTime(0.3 * v, start + 0.031);
        a.exponentialRampToValueAtTime(0.0001, end);
        s.connect(f).connect(g).connect(out);
        break;
      }
      case "hat":
      case "openHat": {
        const open = e.voice === "openHat",
          end = start + (open ? 0.24 : style === "chiptune" ? 0.03 : 0.045);
        const n = this.voice(start, end),
          s = n.noise(0.6),
          f = n.filter("highpass", style === "chiptune" ? 9000 : 7200),
          g = n.gain();
        env(g, start, (open ? 0.11 : 0.09) * v * (style === "lofi" ? 0.7 : 1), 0.002, end);
        s.connect(f).connect(g).connect(out);
        break;
      }
      case "rim": {
        const end = start + 0.05;
        const n = this.voice(start, end),
          o = n.osc("square", 1650),
          f = n.filter("bandpass", 1700, 3),
          g = n.gain();
        env(g, start, 0.12 * v, 0.001, end);
        o.connect(f).connect(g).connect(out);
        break;
      }
      case "crash": {
        const end = start + Math.max(1.2, dur);
        const n = this.voice(start, end),
          s = n.noise(0),
          f = n.filter("highpass", 4200),
          g = n.gain();
        env(g, start, (style === "lofi" ? 0.06 : 0.1) * v, 0.003, end);
        s.connect(f).connect(g).connect(out);
        break;
      }
      case "bass": {
        const f0 = hz(e.pitches[0]),
          end = start + Math.max(0.08, dur * (style === "lofi" ? 0.95 : 0.8));
        const n = this.voice(start, end),
          g = n.gain();
        if (style === "chiptune") {
          const o = n.osc("triangle", f0);
          env(g, start, 0.42 * v, 0.004, end, 0.85);
          o.connect(g).connect(out);
        } else if (style === "disco") {
          const o = n.osc("sawtooth", f0),
            f = n.filter("lowpass", 1500, 4);
          f.frequency.setValueAtTime(1500, start);
          f.frequency.exponentialRampToValueAtTime(380, start + 0.16);
          env(g, start, 0.36 * v, 0.004, end, 0.7);
          o.connect(f).connect(g).connect(out);
        } else {
          const o = n.osc("sine", f0),
            t = n.osc("triangle", f0),
            tg = n.gain(0.25),
            f = n.filter("lowpass", 700);
          env(g, start, 0.48 * v, 0.012, end, 0.8);
          o.connect(g);
          t.connect(tg).connect(g);
          g.connect(f).connect(out);
        }
        break;
      }
      case "arp": {
        // Chiptune chords: short pulse blips (a single long chord at the end).
        const long = e.pitches.length > 1,
          end = start + (long ? dur : Math.min(0.09, dur * 0.8));
        const n = this.voice(start, end),
          g = n.gain();
        env(g, start, (long ? 0.05 : 0.06) * v, 0.003, end, long ? 0.6 : 0);
        for (const p of e.pitches) n.osc(this.pulse(0.125), hz(p)).connect(g);
        g.connect(out);
        break;
      }
      case "stab": {
        const end = start + Math.min(0.18, dur * 0.9);
        const n = this.voice(start, end),
          f = n.filter("lowpass", 2400, 1.2),
          g = n.gain();
        env(g, start, 0.075 * v, 0.004, end);
        for (const p of e.pitches) for (const d of [-9, 9]) n.osc("sawtooth", hz(p), d).connect(f);
        f.connect(g).connect(out);
        break;
      }
      case "pad": {
        const end = start + dur;
        const n = this.voice(start, end),
          f = n.filter("lowpass", 1300),
          g = n.gain();
        env(g, start, 0.05 * v, Math.min(0.25, dur * 0.3), end, 0.85);
        for (const p of e.pitches) for (const d of [-7, 7]) n.osc("sawtooth", hz(p), d).connect(f);
        f.connect(g).connect(out);
        break;
      }
      case "keys": {
        // Electric piano: a sine with a fading octave partial, the chord strummed a little.
        e.pitches.forEach((p, i) => {
          const s = start + i * 0.012,
            end = s + dur;
          const n = this.voice(s, end),
            g = n.gain(),
            o = n.osc("sine", hz(p)),
            o2 = n.osc("sine", hz(p) * 2, 4),
            g2 = n.gain();
          env(g, s, 0.07 * v, 0.01, end, 0.55);
          env(g2, s, 0.035 * v, 0.004, s + 0.35);
          o.connect(g);
          o2.connect(g2).connect(g);
          g.connect(out);
        });
        break;
      }
    }
  }
  /** The melody's voice for `style`. */
  private lead(style: RhythmStyle, pitch: number, start: number, dur: number, out: AudioNode) {
    const env = RhythmMusic.env;
    if (style === "chiptune") {
      const end = start + dur;
      const n = this.voice(start, end),
        o = n.osc(this.pulse(0.25), hz(pitch + 12)),
        g = n.gain();
      if (dur > 0.25) {
        // A little vibrato on long notes.
        const lfo = n.osc("sine", 5.5),
          depth = n.gain(0);
        depth.gain.setValueAtTime(0, start);
        depth.gain.linearRampToValueAtTime(14, start + 0.25);
        lfo.connect(depth).connect(o.detune);
      }
      env(g, start, 0.24, 0.004, end, 0.8);
      o.connect(g).connect(out);
    } else if (style === "disco") {
      const end = start + dur;
      const n = this.voice(start, end),
        f = n.filter("lowpass", 3200, 2),
        g = n.gain();
      f.frequency.setValueAtTime(4200, start);
      f.frequency.exponentialRampToValueAtTime(1600, start + 0.2);
      for (const d of [-6, 6]) n.osc("sawtooth", hz(pitch), d).connect(f);
      env(g, start, 0.2, 0.008, end, 0.75);
      f.connect(g).connect(out);
    } else {
      // A soft bell/marimba: a sine with a bright partial that dies fast.
      const end = start + Math.max(0.5, dur + 0.25);
      const n = this.voice(start, end),
        g = n.gain(),
        o = n.osc("sine", hz(pitch + 12)),
        o2 = n.osc("sine", hz(pitch + 12) * 4),
        g2 = n.gain();
      env(g, start, 0.34, 0.004, end);
      env(g2, start, 0.09, 0.002, start + 0.12);
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(out);
    }
  }
}
