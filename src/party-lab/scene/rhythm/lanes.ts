import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";
import { firstAtOrAfter, GOOD, MISS, PERFECT, WRONG, isHit } from "../../../../shared/party-lab/simulation/rhythm/game";
import { beatAt, beatTime, type Song } from "../../../../shared/party-lab/simulation/rhythm/song";
import type { RhythmLaneView } from "./source";

/** Note colours by key (W, A, S, D): saturated, so they stand apart from the pastel player colours. */
export const KEY_COLORS = ["#ff4d6d", "#4d7cff", "#27c46b", "#ffa41b"] as const;
/** A note takes this long to slide from the lane's right end to the circle, ms. */
export const APPROACH_MS = 1700;
/** The circle's centre from the lane's left edge, as a share of the lane's height. */
const CIRCLE_X = 0.62;
/** What a result says, by grade (MISS, GOOD, PERFECT, WRONG). */
export const WORDS = ["KAÇTI", "İYİ!", "MÜKEMMEL!", "YANLIŞ"] as const;
/** How long a word, a hit's burst, a missed note's fade and a press's flash last, ms. */
export const WORD_MS = 650;
const BURST_MS = 240;
const FADE_MS = 380;
const PRESS_MS = 120;

/** The circle's centre x in a lane of height `h`. */
export const circleX = (h: number) => h * CIRCLE_X + 8;
/** Where a note at `t` is drawn at `now`, in a lane `w` wide and `h` high (it reaches the circle at its moment). */
export const noteX = (t: number, now: number, w: number, h: number) => circleX(h) + ((t - now) / APPROACH_MS) * (w - circleX(h) - h * 0.32);

export interface LaneLook {
  color: string;
  /** This player's own lane: bigger, brighter. */
  self: boolean;
  /** What each note says (the keys bound to them). */
  labels: readonly string[];
  /** Left the round, or the connection dropped. */
  status: "" | "out" | "offline";
}
/** This player's latest key press (the circle lights up in its key's colour). */
export interface LanePress {
  at: number;
  key: number;
}

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
};
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** The most recent result to announce at `now` (a word lasts WORD_MS), or null. */
export function latestWord(view: RhythmLaneView, now: number) {
  let best: { note: number; grade: number; at: number } | null = null;
  for (const [note, r] of view.results) if (r.at <= now + 1 && now - r.at < WORD_MS && (!best || r.at > best.at)) best = { note, grade: r.grade, at: r.at };
  return best;
}

/**
 * One lane, drawn into a 2D canvas of `w` × `h` (CSS pixels): the beat lines, the circle, the
 * notes sliding to it with their keys on them, the burst of a hit, missed notes fading past,
 * and the latest result's word in the player's colour.
 */
export function drawLane(ctx: CanvasRenderingContext2D, w: number, h: number, song: Song, now: number, view: RhythmLaneView, look: LaneLook, press: LanePress | null) {
  ctx.clearRect(0, 0, w, h);
  const cx = circleX(h),
    cy = h / 2,
    r = h * 0.34,
    nr = h * (look.self ? 0.27 : 0.25);
  // The lane.
  roundRect(ctx, 1.5, 1.5, w - 3, h - 3, Math.min(16, h / 4));
  const bg = ctx.createLinearGradient(0, 0, w, 0);
  bg.addColorStop(0, alpha(look.color, look.self ? 0.34 : 0.22));
  bg.addColorStop(0.3, "rgba(18,20,38,0.82)");
  bg.addColorStop(1, "rgba(18,20,38,0.7)");
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = look.self ? 3 : 1.5;
  ctx.strokeStyle = alpha(look.color, look.self ? 0.95 : 0.6);
  ctx.save();
  if (look.self) {
    ctx.shadowColor = alpha(look.color, 0.7);
    ctx.shadowBlur = 14;
  }
  ctx.stroke();
  ctx.restore();
  ctx.save();
  roundRect(ctx, 1.5, 1.5, w - 3, h - 3, Math.min(16, h / 4));
  ctx.clip();
  // Beat lines (bars brighter), sliding with the notes.
  const first = Math.ceil(beatAt(now - (cx / Math.max(1, w - cx)) * APPROACH_MS)),
    last = Math.floor(beatAt(now + APPROACH_MS));
  for (let b = Math.max(0, first); b <= Math.min(last, song.bars.length * 4); b++) {
    const x = noteX(beatTime(b), now, w, h);
    ctx.fillStyle = b % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    ctx.fillRect(x - (b % 4 === 0 ? 1 : 0.5), 6, b % 4 === 0 ? 2 : 1, h - 12);
  }
  // The track the notes run on.
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(cx, cy - nr * 0.55, w - cx, nr * 1.1);
  ctx.restore();

  // The circle: lit by this player's key press, flashed by a hit, red on a slip.
  const word = latestWord(view, now),
    since = word ? now - word.at : Infinity,
    hitFlash = word && isHit(word.grade) && since < BURST_MS ? 1 - since / BURST_MS : 0,
    slipFlash = word && (word.grade === MISS || word.grade === WRONG) && since < 260 ? 1 - since / 260 : 0,
    strayAt = view.strays.reduce((m, at) => (at <= now + 1 ? Math.max(m, at) : m), -1e9),
    strayFlash = now - strayAt < 260 ? 1 - (now - strayAt) / 260 : 0,
    pressFlash = press && now - press.at >= -1 && now - press.at < PRESS_MS ? 1 - (now - press.at) / PRESS_MS : 0;
  // The latest word, in the player's colour, rising from beside the circle (under the notes, which stay readable).
  if (word && since >= 0 && since < WORD_MS) {
    const k = since / WORD_MS,
      pop = since < 90 ? 1.3 - 0.3 * (since / 90) : 1,
      size = h * 0.3 * (word.grade === PERFECT ? 1.08 : word.grade === GOOD ? 0.95 : 0.85) * pop;
    ctx.save();
    ctx.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    ctx.font = `900 ${Math.round(size)}px "Barlow Condensed", Barlow, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tx = cx + r + 12,
      ty = cy - h * 0.12 * easeOut(Math.min(1, k * 2));
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(12,12,28,0.85)";
    ctx.strokeText(WORDS[word.grade], tx, ty);
    ctx.fillStyle = word.grade === MISS || word.grade === WRONG ? alpha(look.color, 0.62) : look.color;
    ctx.fillText(WORDS[word.grade], tx, ty);
    ctx.restore();
  }

  const shake = Math.max(slipFlash, strayFlash) * Math.sin(now * 0.09) * 3;
  ctx.save();
  ctx.translate(shake, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(10,12,26,0.85)";
  ctx.fill();
  if (pressFlash > 0 && press) {
    ctx.fillStyle = alpha(KEY_COLORS[press.key], 0.35 * pressFlash);
    ctx.fill();
  }
  if (hitFlash > 0 && word) {
    ctx.save();
    ctx.shadowColor = alpha(look.color, 0.9);
    ctx.shadowBlur = 24 * hitFlash;
    ctx.fillStyle = alpha(look.color, 0.55 * hitFlash);
    ctx.fill();
    ctx.restore();
  }
  ctx.lineWidth = look.self ? 4 : 2.5;
  ctx.strokeStyle = Math.max(slipFlash, strayFlash) > 0 ? `rgba(255,${Math.round(120 + 135 * (1 - Math.max(slipFlash, strayFlash)))},${Math.round(120 + 135 * (1 - Math.max(slipFlash, strayFlash)))},0.95)` : alpha("#ffffff", look.self ? 0.92 : 0.7);
  ctx.beginPath();
  ctx.arc(cx, cy, r * (1 + 0.12 * hitFlash), 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = alpha(look.color, 0.6);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // The notes, the farthest first (so nearer ones are drawn on top).
  const font = `900 ${Math.round(nr * 1.08)}px "Barlow Condensed", Barlow, sans-serif`;
  const from = firstAtOrAfter(song.notes, now - FADE_MS - R.windows.good - 200),
    to = firstAtOrAfter(song.notes, now + APPROACH_MS + 120);
  for (let i = to - 1; i >= from; i--) {
    const note = song.notes[i],
      result = view.results.get(i),
      x = noteX(note.t, now, w, h);
    if (result && isHit(result.grade)) {
      // A hit: a burst at the circle in the note's colour.
      const k = (now - result.at) / BURST_MS;
      if (k < 0 || k >= 1) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1 + 0.7 * easeOut(k)), 0, Math.PI * 2);
      ctx.lineWidth = 5 * (1 - k);
      ctx.strokeStyle = alpha(KEY_COLORS[note.key], 1 - k);
      ctx.stroke();
      continue;
    }
    let fade = 1,
      grey = false;
    if (result) {
      // Missed or lost: grey, drifting on and fading.
      const k = (now - result.at) / FADE_MS;
      if (k >= 1) continue;
      fade = Math.max(0, 1 - Math.max(0, k)) * 0.75;
      grey = true;
    } else if (x < cx - r) fade = Math.max(0.15, 1 - (cx - r - x) / (r * 3)) * 0.8;
    if (x < -nr || x > w + nr) continue;
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.arc(x, cy, nr, 0, Math.PI * 2);
    ctx.fillStyle = grey ? "#5b5f73" : KEY_COLORS[note.key];
    ctx.fill();
    ctx.lineWidth = look.self ? 3 : 2;
    ctx.strokeStyle = grey ? "rgba(200,200,210,0.6)" : "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(15,15,30,0.75)";
    ctx.strokeText(look.labels[note.key] ?? "", x, cy + nr * 0.06);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(look.labels[note.key] ?? "", x, cy + nr * 0.06);
    if (result?.grade === WRONG) {
      ctx.strokeStyle = "rgba(255,90,90,0.95)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - nr * 0.6, cy - nr * 0.6);
      ctx.lineTo(x + nr * 0.6, cy + nr * 0.6);
      ctx.moveTo(x + nr * 0.6, cy - nr * 0.6);
      ctx.lineTo(x - nr * 0.6, cy + nr * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  if (look.status) {
    ctx.fillStyle = "rgba(10,10,20,0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `800 ${Math.round(h * 0.26)}px Barlow, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(look.status === "out" ? "AYRILDI" : "BAĞLANTI KOPTU", w / 2, cy);
  }
}
