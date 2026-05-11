export type SoundName =
  | "click"
  | "correct"
  | "wrong"
  | "countdown20"
  | "win"
  | "lose";

const SOUND_ENABLED_KEY = "worldQuizSoundEnabled";

const SOUND_PATHS: Record<SoundName, string> = {
  click: "/sounds/click.mp3",
  correct: "/sounds/correct.mp3",
  wrong: "/sounds/wrong.mp3",
  countdown20: "/sounds/countdown20.mp3",
  win: "/sounds/win.mp3",
  lose: "/sounds/lose.mp3",
};

const SOUND_VOLUME: Record<SoundName, number> = {
  click: 0.35,
  correct: 0.55,
  wrong: 0.5,
  countdown20: 0.45,
  win: 0.65,
  lose: 0.6,
};

const audioCache = new Map<SoundName, HTMLAudioElement>();

export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;

  const saved = window.localStorage.getItem(SOUND_ENABLED_KEY);

  if (saved === null) return true;

  return saved === "true";
}

export function setSoundEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(SOUND_ENABLED_KEY, String(enabled));

  if (!enabled) {
    stopAllSounds();
  }
}

export function toggleSoundEnabled(): boolean {
  const next = !isSoundEnabled();
  setSoundEnabled(next);
  return next;
}

function getAudio(name: SoundName): HTMLAudioElement {
  const cached = audioCache.get(name);

  if (cached) return cached;

  const audio = new Audio(SOUND_PATHS[name]);
  audio.preload = "auto";
  audio.volume = SOUND_VOLUME[name];

  audioCache.set(name, audio);

  return audio;
}

export function preloadSounds() {
  (Object.keys(SOUND_PATHS) as SoundName[]).forEach((name) => {
    const audio = getAudio(name);
    audio.preload = "auto";
    audio.load();
  });
}

export function playSound(name: SoundName, options?: { restart?: boolean }) {
  if (!isSoundEnabled()) return;

  try {
    // Uzun/durdurulabilir sesler tek instance kalsın.
    if (name === "countdown20") {
      const audio = getAudio(name);

      if (options?.restart !== false) {
        audio.currentTime = 0;
      }

      audio.volume = SOUND_VOLUME[name];

      void audio.play().catch(() => {
        // Mobil tarayıcılarda kullanıcı etkileşimi olmadan ses engellenebilir.
      });

      return;
    }

    // Kısa efektlerde her seferinde yeni audio kullan.
    // Böylece hızlı tıklamada ses kesilmez.
    const audio = new Audio(SOUND_PATHS[name]);
    audio.volume = SOUND_VOLUME[name];
    audio.preload = "auto";

    void audio.play().catch(() => {
      // Ses oyun akışını bozmasın.
    });
  } catch {
    // sessiz geç
  }
}

export function stopSound(name: SoundName) {
  try {
    const audio = audioCache.get(name);

    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
  } catch {
    // sessiz geç
  }
}

export function stopAllSounds() {
  audioCache.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
}

export function unlockSounds() {
  if (!isSoundEnabled()) return;

  Object.keys(SOUND_PATHS).forEach((key) => {
    try {
      const name = key as SoundName;
      const audio = getAudio(name);
      audio.load();
    } catch {
      // sessiz geç
    }
  });
}