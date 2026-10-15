import { beatTime, degreeSemis, STYLE_MATERIAL, type RhythmStyle, type Song, type SongSection } from "../../../../shared/party-lab/simulation/rhythm/song";
import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";

/**
 * The backing band of a Ritim Ustası song (everything but the melody, which only a player's
 * hits play): drums, bass and chords, bar by bar from the song's harmony and parts, on the
 * song's own tempo map. Pure data; music.ts plays it.
 */
export type BandVoice = "kick" | "snare" | "clap" | "hat" | "openHat" | "rim" | "crash" | "bass" | "arp" | "stab" | "pad" | "keys";
export interface BandEvent {
  /** Start and length, ms (start after BAŞLA). */
  t: number;
  dur: number;
  voice: BandVoice;
  /** MIDI notes (none for drums). */
  pitches: number[];
  /** 0–1. */
  vel: number;
}

/** A bar of sixteenths: "x" a hit, "o" a soft one, "." none. */
type Grid = string;
interface Groove {
  kick: Grid;
  snare?: Grid;
  clap?: Grid;
  hat?: Grid;
  openHat?: Grid;
  rim?: Grid;
  /** Bass as [sixteenth, semitones above the root, length in sixteenths]. */
  bass: readonly (readonly [number, number, number])[];
}
interface StyleBand {
  /** The bass sits this many octaves below the chords. */
  bassOctave: number;
  /** Late sixteenths (0 straight): a lazy swing on the off sixteenths only (the melody is eighths). */
  swing: number;
  grooves: Readonly<Record<Exclude<SongSection, "end">, Groove>>;
  /** The last bar of a part gets this fill on top (sixteenths for the snare). */
  fill: Grid;
}
const BAND: Readonly<Record<RhythmStyle, StyleBand>> = {
  chiptune: {
    bassOctave: 2,
    swing: 0,
    fill: "........x.x.xxxx",
    grooves: {
      intro: { kick: "x.......x.......", hat: "x.o.x.o.x.o.x.o.", bass: [[0, 0, 4], [4, 0, 4], [8, 0, 4], [12, 0, 4]] },
      main: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.o.x.o.x.o.x.o.", bass: [[0, 0, 2], [2, 12, 2], [4, 0, 2], [6, 12, 2], [8, 0, 2], [10, 12, 2], [12, 0, 2], [14, 12, 2]] },
      lift: { kick: "x.....x.x.x.....", snare: "....x.......x...", hat: "xoxoxoxoxoxoxoxo", bass: [[0, 0, 2], [2, 0, 2], [4, 12, 2], [6, 0, 2], [8, 7, 2], [10, 0, 2], [12, 12, 2], [14, 7, 2]] },
      finale: { kick: "x...x...x...x...", snare: "....x.......x..o", hat: "xoxoxoxoxoxoxoxo", bass: [[0, 0, 2], [2, 12, 2], [4, 0, 2], [6, 12, 2], [8, 7, 2], [10, 12, 2], [12, 0, 2], [14, 12, 2]] },
    },
  },
  disco: {
    bassOctave: 2,
    swing: 0,
    fill: "........o.x.xxxx",
    grooves: {
      intro: { kick: "x...x...x...x...", openHat: "..o...o...o...o.", bass: [[0, 0, 4], [4, 0, 4], [8, 0, 4], [12, 0, 4]] },
      main: { kick: "x...x...x...x...", clap: "....x.......x...", hat: "xo.oxo.oxo.oxo.o", openHat: "..x...x...x...x.", bass: [[0, 0, 2], [2, 12, 2], [4, 0, 2], [6, 12, 2], [8, 0, 2], [10, 12, 2], [12, 0, 2], [14, 12, 2]] },
      lift: { kick: "x...x...x...x...", clap: "....x.......x..o", hat: "xo.oxo.oxo.oxo.o", openHat: "..x...x...x...x.", bass: [[0, 0, 2], [2, 12, 2], [4, 0, 2], [6, 12, 1], [7, 10, 1], [8, 0, 2], [10, 12, 2], [12, 0, 1], [13, 0, 1], [14, 12, 2]] },
      finale: { kick: "x...x...x...x...", clap: "....x.......x...", snare: "....o.......o...", hat: "xoxoxoxoxoxoxoxo", openHat: "..x...x...x...x.", bass: [[0, 0, 2], [2, 12, 2], [4, 0, 2], [6, 12, 1], [7, 10, 1], [8, 0, 2], [10, 12, 2], [12, 0, 1], [13, 0, 1], [14, 12, 2]] },
    },
  },
  lofi: {
    bassOctave: 2,
    swing: 0.09,
    fill: "..........o.x.xo",
    grooves: {
      intro: { kick: "x.........x.....", rim: "....o.......o...", hat: "o.o.o.o.o.o.o.o.", bass: [[0, 0, 16]] },
      main: { kick: "x......x..x.....", snare: "....x.......x...", hat: "x.o.x.o.x.o.x.o.", bass: [[0, 0, 6], [6, 7, 2], [8, 0, 4], [12, 12, 2], [14, 7, 2]] },
      lift: { kick: "x......x..x..x..", snare: "....x.......x...", hat: "xooox.oox.oox.oo", bass: [[0, 0, 6], [6, 7, 2], [8, 0, 3], [11, 0, 1], [12, 12, 2], [14, 7, 2]] },
      finale: { kick: "x...x..x..x.x...", snare: "....x.......x...", hat: "xoooxoooxoooxooo", openHat: "..............x.", bass: [[0, 0, 4], [4, 7, 2], [6, 12, 2], [8, 0, 3], [11, 0, 1], [12, 12, 2], [14, 7, 2]] },
    },
  },
};
/** Bars that end a part (a fill on top) and bars that start one (a crash). */
const FILL_BARS = new Set([1, 9, 17, 21]);
const CRASH_BARS = new Set([2, 10, 14, 18, 20, 22]);

/** The sixteenth `step` of bar `bar` as a beat (with the style's swing on the off sixteenths). */
export const stepBeat = (bar: number, step: number, swing = 0) => bar * R.song.beatsPerBar + step / 4 + (step % 2 === 1 ? swing : 0);

/** Every backing event of `song`, in time order. */
export function arrange(song: Song): BandEvent[] {
  const band = BAND[song.style],
    m = STYLE_MATERIAL[song.style],
    events: BandEvent[] = [];
  const at = (bar: number, step: number) => beatTime(stepBeat(bar, step, band.swing));
  const span = (bar: number, step: number, steps: number) => beatTime(stepBeat(bar, step + steps)) - beatTime(stepBeat(bar, step));
  const push = (voice: BandVoice, bar: number, step: number, steps: number, vel: number, pitches: number[] = []) => events.push({ t: at(bar, step), dur: span(bar, step, steps), voice, pitches, vel });
  const drums = (voice: BandVoice, grid: Grid | undefined, bar: number, loud: number) => {
    if (!grid) return;
    for (let step = 0; step < 16; step++) if (grid[step] !== ".") push(voice, bar, step, 1, (grid[step] === "x" ? 1 : 0.55) * loud);
  };
  for (const b of song.bars) {
    const bar = b.bar;
    const chord = b.chord,
      bassRoot = m.tonic + degreeSemis(b.root) - 12 * band.bassOctave;
    if (b.section === "end") {
      // The last chord: everything lands together and rings.
      push("kick", bar, 0, 1, 1);
      push("crash", bar, 0, 8, 0.9);
      push("bass", bar, 0, 12, 0.9, [bassRoot]);
      push(song.style === "chiptune" ? "arp" : song.style === "disco" ? "pad" : "keys", bar, 0, 14, 0.8, chord);
      if (song.style === "disco") push("stab", bar, 0, 2, 0.8, chord);
      continue;
    }
    const groove = band.grooves[b.section],
      loud = b.section === "intro" ? 0.75 : b.section === "finale" ? 1 : 0.9;
    drums("kick", groove.kick, bar, loud);
    drums("snare", groove.snare, bar, loud);
    drums("clap", groove.clap, bar, loud);
    drums("hat", groove.hat, bar, loud);
    drums("openHat", groove.openHat, bar, loud);
    drums("rim", groove.rim, bar, loud);
    if (FILL_BARS.has(bar)) drums(song.style === "disco" ? "clap" : "snare", band.fill, bar, loud * 0.85);
    if (CRASH_BARS.has(bar)) push("crash", bar, 0, 8, b.section === "finale" ? 0.75 : 0.6);
    for (const [step, semis, steps] of groove.bass) push("bass", bar, step, steps, b.section === "intro" ? 0.7 : 0.85, [bassRoot + semis]);
    // Chords, the style's way.
    if (song.style === "chiptune") {
      // A quick arpeggio up the chord and its octave, every sixteenth.
      const tones = [...chord, chord[0] + 12];
      for (let step = 0; step < 16; step++) push("arp", bar, step, 1, b.section === "intro" ? 0.55 : 0.75, [tones[step % tones.length] + 12]);
    } else if (song.style === "disco") {
      const stabs = b.section === "intro" ? [0] : b.section === "main" ? [2, 6, 10, 14] : [0, 2, 6, 10, 14];
      for (const step of stabs) push("stab", bar, step, step === 0 ? 2 : 1, step === 0 ? 0.7 : 0.6, chord);
      if (b.section === "finale" || b.section === "intro") push("pad", bar, 0, 16, b.section === "intro" ? 0.6 : 0.5, chord);
    } else {
      // Electric piano: on the one and pushed onto the "and" of two, or held through the intro.
      if (b.section === "intro") push("keys", bar, 0, 16, 0.7, chord);
      else {
        push("keys", bar, 0, 6, 0.75, chord);
        push("keys", bar, 6, 10, 0.6, chord);
      }
    }
  }
  return events.sort((a, b) => a.t - b.t);
}
