import { RHYTHM as R } from "./config.js";
import { mulberry32 } from "../colors/layouts.js";

/**
 * Ritim Ustası's song: one of three original styles, composed from a seed. The server and every
 * browser compose the same song from the same (style, seed), so only those two numbers travel.
 * The melody IS the chart: every melody note is a note to press, its key comes from its pitch
 * within its part of the song (the highest notes W, then D, A, the lowest S), and on a player's
 * screen it sounds only when that player hits it. Chords, bass and drums (the browser's arrangement) follow the same bars
 * and the same tempo map, so every note sits on the beat.
 */
export const RHYTHM_STYLES = ["chiptune", "disco", "lofi"] as const;
export type RhythmStyle = (typeof RHYTHM_STYLES)[number];
export const RHYTHM_STYLE_NAMES: Readonly<Record<RhythmStyle, string>> = { chiptune: "8-bit", disco: "Disko", lofi: "Lo-fi pop" };
export const isRhythmStyle = (value: unknown): value is RhythmStyle => typeof value === "string" && (RHYTHM_STYLES as readonly string[]).includes(value);

export const KEY_W = 0,
  KEY_A = 1,
  KEY_S = 2,
  KEY_D = 3;
/** What every note says on it, by key. */
export const KEY_LETTERS = ["W", "A", "S", "D"] as const;

/** Bars of the song by part: two bars of intro, the main part twice, the livelier part twice, the finale, then the last chord. */
export type SongSection = "intro" | "main" | "lift" | "finale" | "end";
export const SECTION_BARS: readonly { section: SongSection; from: number; to: number }[] = [
  { section: "intro", from: 0, to: 2 },
  { section: "main", from: 2, to: 10 },
  { section: "lift", from: 10, to: 18 },
  { section: "finale", from: 18, to: 22 },
  { section: "end", from: 22, to: 23 },
];
export const sectionOf = (bar: number): SongSection => SECTION_BARS.find((s) => bar >= s.from && bar < s.to)?.section ?? "end";

// ── Tempo ────────────────────────────────────────────────────────────────────────────────
/** Beats of the song before its last chord (the tempo rises over them). */
export const SONG_BEATS = R.song.bars * R.song.beatsPerBar;
const B0 = R.song.bpm.start,
  B1 = R.song.bpm.end,
  RAMP = (60000 * SONG_BEATS) / (B1 - B0),
  END = RAMP * Math.log(B1 / B0);
/** The tempo at `beat`: rising linearly from 110 to 140 BPM, then held. */
export const bpmAt = (beat: number) => (beat <= 0 ? B0 : beat >= SONG_BEATS ? B1 : B0 + ((B1 - B0) * beat) / SONG_BEATS);
/** The moment of `beat` (ms after BAŞLA): the integral of 60 s / bpm, so the tempo glides with no step. */
export function beatTime(beat: number) {
  if (beat <= 0) return (beat * 60000) / B0;
  if (beat >= SONG_BEATS) return END + ((beat - SONG_BEATS) * 60000) / B1;
  return RAMP * Math.log(1 + ((B1 - B0) * beat) / (B0 * SONG_BEATS));
}
/** The beat at `ms` (the inverse of beatTime). */
export function beatAt(ms: number) {
  if (ms <= 0) return (ms * B0) / 60000;
  if (ms >= END) return SONG_BEATS + ((ms - END) * B1) / 60000;
  return ((Math.exp(ms / RAMP) - 1) * B0 * SONG_BEATS) / (B1 - B0);
}

// ── Harmony ──────────────────────────────────────────────────────────────────────────────
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** Semitones above the tonic of major-scale degree `d` (0 the tonic, 7 an octave up, −1 the leading note below). */
export const degreeSemis = (d: number) => 12 * Math.floor(d / 7) + MAJOR[((d % 7) + 7) % 7];

/**
 * A style's material. `tonic` is the key (MIDI, octave 4: degree 0 of the melody and the
 * chords); `intro` and `progression` are chord roots as scale degrees (I = 0 … vi = 5), the
 * chords stacked in thirds on the scale (with sevenths when `sevenths`). Bars of melody are
 * written in eighths: "deg/len" tokens (or "r/len" a rest) adding up to 8; the main and lively
 * parts are four bars over the progression, played twice (the second time with small seeded
 * changes, sometimes another last bar).
 */
interface StyleMaterial {
  tonic: number;
  sevenths: boolean;
  intro: readonly [number, number];
  progression: readonly [number, number, number, number];
  /** The second intro bar (the first one has no notes). */
  introBar: string;
  main: readonly [string, string, string, string];
  mainEndings: readonly string[];
  lift: readonly [string, string, string, string];
  liftEndings: readonly string[];
  finale: readonly [string, string, string, string];
}
export const STYLE_MATERIAL: Readonly<Record<RhythmStyle, StyleMaterial>> = {
  // C major, I–V–vi–IV (C G Am F): a bouncy pulse-wave hook.
  chiptune: {
    tonic: 60,
    sevenths: false,
    intro: [3, 4],
    progression: [0, 4, 5, 3],
    introBar: "4/4 1/4",
    main: ["4/2 4/1 5/1 4/2 2/2", "1/3 2/1 4/4", "4/2 4/1 5/1 4/2 7/2", "5/2 3/2 2/4"],
    mainEndings: ["5/1 4/1 3/2 2/4", "3/2 5/2 4/4"],
    lift: ["4/1 4/1 4/1 5/1 4/1 2/1 0/2", "1/1 2/1 1/1 -1/1 1/2 4/2", "4/1 4/1 4/1 5/1 4/1 7/1 5/2", "5/1 5/1 3/1 5/1 7/2 4/2"],
    liftEndings: ["5/1 7/1 5/1 3/1 2/2 4/2", "3/1 5/1 7/1 5/1 4/2 r/2"],
    finale: ["7/1 7/1 9/1 7/1 11/2 9/2", "8/1 9/1 8/1 6/1 8/2 11/2", "7/1 9/1 12/1 11/1 9/1 7/1 9/2", "10/1 9/1 7/1 5/1 7/2 8/2"],
  },
  // F major, IV–V–iii–vi with sevenths (B♭maj7 C7 Am7 Dm7): syncopated, funky.
  disco: {
    tonic: 65,
    sevenths: true,
    intro: [0, 4],
    progression: [3, 4, 2, 5],
    introBar: "6/4 4/4",
    main: ["5/2 5/1 7/2 5/1 3/2", "4/3 6/1 4/2 r/2", "6/2 6/1 8/2 6/1 4/2", "5/2 7/2 9/4"],
    mainEndings: ["9/2 7/2 5/4", "5/1 7/1 9/2 8/2 7/2"],
    lift: ["5/1 5/1 7/1 5/1 9/2 7/2", "4/1 6/1 8/1 6/1 4/1 3/1 4/2", "6/1 6/1 8/1 6/1 11/2 9/2", "9/1 7/1 5/1 7/1 9/1 11/1 12/2"],
    liftEndings: ["12/1 11/1 9/1 7/1 9/2 5/2", "9/1 9/1 7/1 9/1 11/2 r/2"],
    finale: ["9/1 9/1 10/1 9/1 7/2 5/2", "8/1 8/1 10/1 8/1 6/2 4/2", "8/1 9/1 11/1 9/1 8/1 6/1 8/2", "7/1 9/1 12/1 11/1 9/1 7/1 8/2"],
  },
  // D major, I–vi–IV–V with sevenths (Dmaj7 Bm7 Gmaj7 A7): soft and sweet.
  lofi: {
    tonic: 62,
    sevenths: true,
    intro: [3, 4],
    progression: [0, 5, 3, 4],
    introBar: "4/4 6/4",
    main: ["2/1 2/1 4/2 6/3 4/1", "5/2 4/2 2/4", "2/1 2/1 4/2 5/3 4/1", "4/2 2/2 1/4"],
    mainEndings: ["1/2 2/2 4/4", "6/2 4/2 1/4"],
    lift: ["2/1 4/1 6/1 7/1 6/1 4/1 2/2", "5/1 4/1 2/1 4/1 5/2 7/2", "3/1 5/1 7/1 9/1 8/1 7/1 5/2", "4/1 6/1 8/1 6/1 4/2 r/2"],
    liftEndings: ["8/1 7/1 6/1 4/1 6/2 r/2", "4/1 6/1 8/1 10/1 8/2 r/2"],
    finale: ["9/1 9/1 7/1 9/1 11/2 9/2", "8/1 7/1 5/1 7/1 9/2 11/2", "7/1 9/1 10/1 9/1 7/1 5/1 7/2", "8/1 6/1 4/1 6/1 8/1 10/1 8/2"],
  },
};
/** The last note (and chord): the tonic an octave up, held a bar. */
const FINAL_DEGREE = 7;

/** One bar's harmony: its chord root (a scale degree), the chord's notes (MIDI, around octave 4) and its part. */
export interface SongBar {
  bar: number;
  root: number;
  chord: number[];
  section: SongSection;
}
/** One melody note, which is one note of the chart: its beat and length, its pitch, its key and its moments (ms after BAŞLA). */
export interface SongNote {
  beat: number;
  len: number;
  pitch: number;
  key: number;
  t: number;
  end: number;
}
export interface Song {
  style: RhythmStyle;
  seed: number;
  /** Every bar, the last chord's bar included. */
  bars: SongBar[];
  /** The chart, in time order. */
  notes: SongNote[];
  /** When the last chord starts (ms after BAŞLA). */
  endAt: number;
}

interface Written {
  pos: number;
  len: number;
  deg: number | null;
}
/** A written bar ("deg/len …" in eighths) as notes and rests. */
export function parseBar(bar: string): Written[] {
  let pos = 0;
  const out = bar
    .trim()
    .split(/\s+/)
    .map((token) => {
      const [deg, len] = token.split("/");
      const w = { pos, len: Number(len), deg: deg === "r" ? null : Number(deg) };
      if (!Number.isInteger(w.len) || w.len < 1 || (w.deg !== null && !Number.isInteger(w.deg))) throw Error(`Ritim Ustası: bad token ${token}`);
      pos += w.len;
      return w;
    });
  if (pos !== 8) throw Error(`Ritim Ustası: a bar of ${pos} eighths: ${bar}`);
  return out;
}
/** The chord on `root` (scale degree) in the key of `tonic`: a triad, or a seventh chord. */
export const chordOn = (tonic: number, root: number, sevenths: boolean) => (sevenths ? [0, 2, 4, 6] : [0, 2, 4]).map((step) => tonic + degreeSemis(root + step));

/**
 * The second time through a part: small seeded changes. A note off the beat may step to a
 * neighbouring degree; in the main part a quarter on beat 2 or 4 may split into two eighths;
 * the last bar may be another ending.
 */
function vary(bars: readonly string[], endings: readonly string[], random: () => number, split: boolean): Written[][] {
  return bars.map((bar, i) => {
    let notes = parseBar(i === 3 && random() < 0.35 ? endings[Math.min(endings.length - 1, Math.floor(random() * endings.length))] : bar);
    notes = notes.flatMap((n) => {
      if (n.deg === null) return [n];
      if (split && n.len === 2 && (n.pos === 2 || n.pos === 6) && random() < 0.2)
        return [
          { pos: n.pos, len: 1, deg: n.deg },
          { pos: n.pos + 1, len: 1, deg: n.deg + (random() < 0.5 ? 0 : random() < 0.5 ? 1 : -1) },
        ];
      return [n];
    });
    return notes.map((n) => (n.deg !== null && n.pos % 2 === 1 && random() < 0.15 ? { ...n, deg: n.deg + (random() < 0.5 ? 1 : -1) } : n));
  });
}

/**
 * Keys by pitch: the distinct pitches from low to high, cut into four runs (S, A, D, W) of about
 * the same number of notes: of every way to cut them with no run empty, the one closest to a
 * quarter each (the first such in order). The same pitch is always the same key, so a repeated
 * motif is the same pattern of keys.
 */
export function keysByPitch(pitches: readonly number[]) {
  const count = new Map<number, number>();
  for (const p of pitches) count.set(p, (count.get(p) ?? 0) + 1);
  const distinct = [...count.keys()].sort((a, b) => a - b),
    sizes = distinct.map((p) => count.get(p)!),
    order = [KEY_S, KEY_A, KEY_D, KEY_W],
    keys = new Map<number, number>(),
    n = distinct.length,
    quarter = pitches.length / 4;
  if (n < 4) {
    // Too few pitches for four keys: spread them out from the lowest key up.
    distinct.forEach((p, i) => keys.set(p, order[Math.round((i * 3) / Math.max(1, n - 1))]));
    return keys;
  }
  const sum = (from: number, to: number) => sizes.slice(from, to).reduce((a, b) => a + b, 0);
  let best = [1, 2, 3],
    bestCost = Infinity;
  for (let a = 1; a < n - 2; a++)
    for (let b = a + 1; b < n - 1; b++)
      for (let c = b + 1; c < n; c++) {
        const cost = [sum(0, a), sum(a, b), sum(b, c), sum(c, n)].reduce((m, size) => m + (size - quarter) ** 2, 0);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          best = [a, b, c];
        }
      }
  distinct.forEach((p, i) => keys.set(p, order[i < best[0] ? 0 : i < best[1] ? 1 : i < best[2] ? 2 : 3]));
  return keys;
}

/**
 * A fingerprint of the chart (FNV-1a over every note's eighth, key and pitch): the server sends
 * it with the style and seed, so a browser composing a different song (another build) knows.
 */
export function chartHash(notes: readonly { beat: number; key: number; pitch: number }[]) {
  let h = 0x811c9dc5;
  for (const n of notes)
    for (const v of [Math.round(n.beat * 2), n.key, n.pitch]) {
      h ^= v & 0xffff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  return h >>> 0;
}

/** The song of `style` from `seed`: the same on the server and in every browser. */
export function composeSong(style: RhythmStyle, seed: number): Song {
  const m = STYLE_MATERIAL[style],
    random = mulberry32(seed),
    perBar = R.song.beatsPerBar;
  const bars: SongBar[] = [];
  for (let bar = 0; bar <= R.song.bars; bar++) {
    const root = bar < 2 ? m.intro[bar] : bar < R.song.bars ? m.progression[(bar - 2) % 4] : 0;
    bars.push({ bar, root, chord: chordOn(m.tonic, root, m.sevenths), section: sectionOf(bar) });
  }
  // The melody bar by bar: bar 0 silent, the intro's call, main ×2, lift ×2, finale, the last note.
  const written: Written[][] = [
    [],
    parseBar(m.introBar),
    ...m.main.map(parseBar),
    ...vary(m.main, m.mainEndings, random, true),
    ...m.lift.map(parseBar),
    ...vary(m.lift, m.liftEndings, random, false),
    ...m.finale.map(parseBar),
  ];
  const raw = written.flatMap((notes, bar) => notes.flatMap((n) => (n.deg === null ? [] : [{ beat: bar * perBar + n.pos / 2, len: n.len / 2, pitch: m.tonic + degreeSemis(n.deg) }])));
  raw.push({ beat: R.song.bars * perBar, len: perBar, pitch: m.tonic + degreeSemis(FINAL_DEGREE) });
  // Keys by pitch within each part (intro and main, lift, finale): every part spreads over all
  // four keys, and a repeated motif is the same pattern of keys.
  const part = (beat: number) => (beat < 10 * perBar ? 0 : beat < 18 * perBar ? 1 : 2);
  const keys = [0, 1, 2].map((p) => keysByPitch(raw.filter((n) => part(n.beat) === p).map((n) => n.pitch)));
  const notes = raw.map((n) => ({ ...n, key: keys[part(n.beat)].get(n.pitch)!, t: beatTime(n.beat), end: beatTime(n.beat + n.len) }));
  return { style, seed: seed >>> 0, bars, notes, endAt: beatTime(R.song.bars * perBar) };
}
