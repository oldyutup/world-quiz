/**
 * conquestSound — Kuşatma-mode sound manager.
 *
 * Owns a small palette of war/strategy FX that the gameplay layer fires
 * through `playConquestSound(name)`.  Decoupled from the global
 * `lib/sound.ts` palette so adding/tuning conquest sounds never touches
 * the rest of the app's audio.
 *
 * Resilience:
 *   • Assets live under /assets/sounds/conquest/ but may not be checked in
 *     yet.  A failed load is recorded once per sound and silently no-ops
 *     on every subsequent call — no console spam, no thrown errors.
 *   • Respects the global `isSoundEnabled` toggle from lib/sound.ts so the
 *     user's existing mute preference applies here too.
 *   • Browser autoplay restrictions are handled by `unlockConquestSounds`
 *     (called after the user's first interaction inside the game screen);
 *     plays before that simply fail silently.
 *
 * Volume sits in the low/medium range; one VOLUME constant per sound for
 * future tuning.
 */

import { isSoundEnabled } from "../../lib/sound";

export type ConquestSoundName =
  | "answer-submit"
  | "reveal-win"
  | "reveal-neutral"
  | "reveal-fail"
  | "turn-yours"
  | "turn-theirs"
  | "capture"
  | "bonus-capture"
  | "shield-break"
  | "duel-start"
  | "duel-win"
  | "duel-lose"
  | "duel-spectator"
  | "round-start"
  | "hidden-operation"
  | "attack-focus"
  | "match-win"
  | "match-lose";

const SOUND_BASE = "/assets/sounds/conquest";

const SOUND_PATHS: Record<ConquestSoundName, string> = {
  "answer-submit":  `${SOUND_BASE}/answer-submit.mp3`,
  "reveal-win":     `${SOUND_BASE}/reveal-win.mp3`,
  "reveal-neutral": `${SOUND_BASE}/reveal-neutral.mp3`,
  "reveal-fail":    `${SOUND_BASE}/reveal-fail.mp3`,
  "turn-yours":     `${SOUND_BASE}/turn-yours.mp3`,
  "turn-theirs":    `${SOUND_BASE}/turn-theirs.mp3`,
  "capture":        `${SOUND_BASE}/capture.mp3`,
  "bonus-capture":  `${SOUND_BASE}/bonus-capture.mp3`,
  "shield-break":   `${SOUND_BASE}/shield-break.mp3`,
  "duel-start":     `${SOUND_BASE}/duel-start.mp3`,
  "duel-win":       `${SOUND_BASE}/duel-win.mp3`,
  "duel-lose":      `${SOUND_BASE}/duel-lose.mp3`,
  "duel-spectator":  `${SOUND_BASE}/duel-spectator.mp3`,
  "round-start":     `${SOUND_BASE}/round-start.mp3`,
  "hidden-operation":`${SOUND_BASE}/hidden-operation.mp3`,
  "attack-focus":    `${SOUND_BASE}/attack-focus.mp3`,
  "match-win":       `${SOUND_BASE}/match-win.mp3`,
  "match-lose":      `${SOUND_BASE}/match-lose.mp3`,
};

const SOUND_VOLUME: Record<ConquestSoundName, number> = {
  "answer-submit":  0.30,
  "reveal-win":     0.55,
  "reveal-neutral": 0.40,
  "reveal-fail":    0.45,
  "turn-yours":     0.55,
  "turn-theirs":    0.32,
  "capture":        0.55,
  "bonus-capture":  0.65,
  "shield-break":   0.55,
  "duel-start":     0.55,
  "duel-win":       0.60,
  "duel-lose":      0.55,
  "duel-spectator":  0.38,
  "round-start":     0.55,
  "hidden-operation":0.55,
  "attack-focus":    0.55,
  "match-win":       0.70,
  "match-lose":      0.55,
};

/** Minimum gap (ms) between plays of the same sound; protects against
 *  duplicate React effects re-firing the same trigger within a tick. */
const MIN_REPLAY_GAP_MS = 120;

/** Sounds known to be missing on disk — skipped silently after the first
 *  failed load to avoid console spam. */
const missingSounds = new Set<ConquestSoundName>();

/** Last successful play timestamp per sound — drives the soft dedupe. */
const lastPlayedAt: Map<ConquestSoundName, number> = new Map();

/** Cached audio instances used by `unlockConquestSounds`.  Per-play we
 *  still build a fresh `Audio` so overlapping triggers (e.g. capture +
 *  shield-break) never clip each other. */
const audioCache: Map<ConquestSoundName, HTMLAudioElement> = new Map();

function getOrCreateAudio(name: ConquestSoundName): HTMLAudioElement | null {
  if (missingSounds.has(name))            return null;
  if (typeof window === "undefined")      return null;
  const cached = audioCache.get(name);
  if (cached) return cached;
  try {
    const audio = new Audio(SOUND_PATHS[name]);
    audio.preload = "auto";
    audio.volume  = SOUND_VOLUME[name];
    audioCache.set(name, audio);
    return audio;
  } catch {
    missingSounds.add(name);
    return null;
  }
}

/**
 * Best-effort preload.  Called after the user's first interaction so
 * browser autoplay policies treat subsequent `.play()` calls as
 * user-initiated.  Failures (404s for not-yet-shipped assets) are
 * recorded and silently skipped on future calls.
 */
export function unlockConquestSounds(): void {
  if (!isSoundEnabled())             return;
  if (typeof window === "undefined") return;

  (Object.keys(SOUND_PATHS) as ConquestSoundName[]).forEach((name) => {
    const audio = getOrCreateAudio(name);
    if (!audio) return;
    try {
      audio.load();
    } catch {
      missingSounds.add(name);
    }
  });
}

/**
 * Fire a conquest sound.  No-ops when:
 *   • global sound is muted,
 *   • the asset failed to load previously,
 *   • the same sound fired within MIN_REPLAY_GAP_MS,
 *   • the browser blocked playback (autoplay, no user gesture).
 *
 * All failures are swallowed — gameplay must never break because audio
 * is missing.
 */
export function playConquestSound(name: ConquestSoundName): void {
  if (!isSoundEnabled())             return;
  if (typeof window === "undefined") return;
  if (missingSounds.has(name))       return;

  const now  = Date.now();
  const last = lastPlayedAt.get(name) ?? 0;
  if (now - last < MIN_REPLAY_GAP_MS) return;

  try {
    // Build a fresh Audio per fire so overlapping triggers (capture +
    // shield-break in the same tick) don't cut each other off.
    const audio = new Audio(SOUND_PATHS[name]);
    audio.volume  = SOUND_VOLUME[name];
    audio.preload = "auto";

    const onError = () => {
      missingSounds.add(name);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("error", onError, { once: true });

    const playPromise = audio.play();
    lastPlayedAt.set(name, now);

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        // Autoplay blocks or asset-missing — silent no-op.
      });
    }
  } catch {
    missingSounds.add(name);
  }
}
