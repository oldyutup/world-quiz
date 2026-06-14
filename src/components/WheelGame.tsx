/**
 * WheelGame.tsx — Offline Çark Modu (Wheel Mode)
 *
 * UX:
 *   - Tek ekran. Üst barda kıta/zorluk/süre dropdownları, skor, can, timer.
 *   - Harita hemen görünür. Başlangıçta CTA: "Çarkı çevir ve hedef ülkeyi bul".
 *   - İlk "Çarkı Çevir" tıklamasında oyun başlar: timer çalışmaya başlar,
 *     ayar dropdown'ları disabled olur.
 *   - Doğru tıklamada skor +1, ülke yeşil. Yanlışta can -1, ülke kırmızı flash.
 *   - Süre bitince veya canlar bitince sonuç ekranı.
 *
 * Modülerlik notu: Online genişleme için PlayState ayrı bir reducer'a
 * dönüştürülebilir; şimdilik tek component içinde tutuyoruz.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import WorldMap from "./WorldMap";
import {
  getFlagPool,
  getContinentIds,
  type Continent,
  type CountryEntry,
  type Difficulty,
} from "../data/countries";
import { playSound, stopSound, shouldPlayCountdownSound, getCountdownSoundMode } from "../lib/sound";
import { recordGameComplete } from "../lib/achievementStats";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type ContinentFilter = Continent | "world";
type LifeMode = "lives" | "endless";

const INITIAL_LIVES = 3;
const MAX_LIVES = 5;
const WRONG_FLASH_MS = 600;
const LIFE_GAIN_TOAST_MS = 1500;
const SPIN_MIN_MS = 700;
const SPIN_MAX_MS = 1200;
const SPIN_TICK_MS = 70;

const DURATION_OPTIONS: { label: string; value: number }[] = [
  { label: "15 sn", value: 15  },
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const CONTINENT_OPTIONS: { label: string; value: ContinentFilter }[] = [
  { label: "🌍 Dünya",      value: "world"         },
  { label: "🇪🇺 Avrupa",    value: "europe"        },
  { label: "🌏 Asya",       value: "asia"          },
  { label: "🌍 Afrika",     value: "africa"        },
  { label: "🌎 K.Amerika",  value: "north-america" },
  { label: "🌎 G.Amerika",  value: "south-america" },
  { label: "🌊 Okyanusya",  value: "oceania"       },
];

const DIFFICULTY_OPTIONS: { label: string; value: Difficulty }[] = [
  { label: "🧩 Kolay", value: "easy"   },
  { label: "🔸 Orta",  value: "normal" },
  { label: "👑 Zor",   value: "hard"   },
  { label: "🗺️ Tümü",  value: "all"    },
];

const LIFE_MODE_OPTIONS: { label: string; value: LifeMode }[] = [
  { label: "❤️ Canlı",   value: "lives"   },
  { label: "∞ Cansız",  value: "endless" },
];

interface GameOverResult {
  score: number;
  livesLeft: number;
  reason: "time" | "lives" | "pool";
  passCount: number;
}

/* ═══════════════════════════════════════════════════════════════
   POOL HELPER — getFlagPool returns code-bearing entries; we
   additionally require topoId because the map click resolves topoId.
═══════════════════════════════════════════════════════════════ */
function buildWheelPool(
  continent: ContinentFilter,
  difficulty: Difficulty
): CountryEntry[] {
  return getFlagPool(continent, difficulty).filter((c) => Boolean(c.topoId));
}

/* ═══════════════════════════════════════════════════════════════
   GENERIC DROPDOWN — local to WheelGame, isolated from App.tsx
═══════════════════════════════════════════════════════════════ */
interface DropdownOption<T> { label: string; value: T }

interface WheelDropdownProps<T extends string | number> {
  options: DropdownOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

function WheelDropdown<T extends string | number>(
  p: WheelDropdownProps<T>
) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Close popover if disabled toggles on while open
  useEffect(() => {
    if (p.disabled && open) setOpen(false);
  }, [p.disabled, open]);

  const current = p.options.find((o) => o.value === p.value);

  return (
    <div className="wheel-dd" ref={wrapRef}>
      <button
        type="button"
        className={"wheel-dd-trigger" + (open ? " open" : "")}
        disabled={p.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={p.ariaLabel}
        onClick={() => { playSound("click"); setOpen((o) => !o); }}
      >
        <span className="wheel-dd-label">{current?.label ?? "—"}</span>
        <span className={"wheel-dd-caret" + (open ? " up" : "")}>▾</span>
      </button>
      {open && (
        <div className="wheel-dd-menu" role="listbox">
          {p.options.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              role="option"
              aria-selected={opt.value === p.value}
              className={"wheel-dd-item" + (opt.value === p.value ? " active" : "")}
              onClick={() => {
                playSound("click");
                p.onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MOBILE SETTINGS — gear button + panel that re-uses WheelDropdown
   so settings keep their single source of truth (state still lives
   in <WheelGame />). Hidden on desktop via CSS.
═══════════════════════════════════════════════════════════════ */
interface WheelMobileSettingsProps {
  continent:  ContinentFilter; setContinent:  (v: ContinentFilter) => void;
  difficulty: Difficulty;       setDifficulty: (v: Difficulty) => void;
  duration:   number;           setDuration:   (v: number) => void;
  lifeMode:   LifeMode;         setLifeMode:   (v: LifeMode) => void;
  disabled:   boolean;
}
function WheelMobileSettings(p: WheelMobileSettingsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Auto-close when crossing into desktop width so resizing the window doesn't
  // leave a stale panel attached to a now-hidden button.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 721px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    if (mq.matches) setOpen(false);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return (
    <div className="wheel-mobile-settings" ref={rootRef}>
      <button
        type="button"
        className={"wheel-settings-btn" + (open ? " open" : "")}
        onClick={() => { playSound("click"); setOpen(o => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ayarlar"
        title="Ayarlar"
      >
        <span aria-hidden="true">⚙️</span>
      </button>
      {open && (
        <div className="wheel-settings-panel" role="menu" aria-label="Oyun ayarları">
          <div className="wheel-settings-header">
            <span className="wheel-settings-title">⚙️ Ayarlar</span>
            <button
              type="button"
              className="wheel-settings-close"
              onClick={() => { playSound("click"); setOpen(false); }}
              aria-label="Kapat"
            >✕</button>
          </div>
          <div className="wheel-settings-row">
            <span className="wheel-settings-lbl">🌍 Bölge</span>
            <WheelDropdown
              options={CONTINENT_OPTIONS}
              value={p.continent}
              onChange={p.setContinent}
              disabled={p.disabled}
              ariaLabel="Kıta"
            />
          </div>
          <div className="wheel-settings-row">
            <span className="wheel-settings-lbl">🔶 Zorluk</span>
            <WheelDropdown
              options={DIFFICULTY_OPTIONS}
              value={p.difficulty}
              onChange={p.setDifficulty}
              disabled={p.disabled}
              ariaLabel="Zorluk"
            />
          </div>
          <div className="wheel-settings-row">
            <span className="wheel-settings-lbl">⏱ Süre</span>
            <WheelDropdown
              options={DURATION_OPTIONS}
              value={p.duration}
              onChange={p.setDuration}
              disabled={p.disabled}
              ariaLabel="Süre"
            />
          </div>
          <div className="wheel-settings-row">
            <span className="wheel-settings-lbl">❤️ Can Modu</span>
            <WheelDropdown
              options={LIFE_MODE_OPTIONS}
              value={p.lifeMode}
              onChange={p.setLifeMode}
              disabled={p.disabled}
              ariaLabel="Can Modu"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULT SCREEN (kept from previous version — user is happy with it)
═══════════════════════════════════════════════════════════════ */

interface ResultProps {
  result: GameOverResult;
  duration: number;
  continent: ContinentFilter;
  difficulty: Difficulty;
  lifeMode: LifeMode;
  onReplay: () => void;
  onHome: () => void;
}

function ResultScreen(p: ResultProps) {
  const contLabel = CONTINENT_OPTIONS.find((c) => c.value === p.continent)?.label ?? "Dünya";
  const durLabel  = DURATION_OPTIONS.find((d) => d.value === p.duration)?.label ?? `${p.duration} sn`;
  const diffLabel = DIFFICULTY_OPTIONS.find((d) => d.value === p.difficulty)?.label ?? "Tümü";
  const lifeLabel = LIFE_MODE_OPTIONS.find((l) => l.value === p.lifeMode)?.label ?? "❤️ Canlı";

  const reasonText =
    p.result.reason === "time"
      ? "Süre Doldu"
      : p.result.reason === "lives"
      ? "Canlar Bitti"
      : "Havuz Tükendi";
  const reasonEmoji =
    p.result.reason === "time" ? "⏰" : p.result.reason === "lives" ? "💔" : "🏁";

  return (
    <div className="wheel-result-backdrop">
      <div className="wheel-result-panel">
        <div className="wheel-result-emoji">{reasonEmoji}</div>
        <h2 className="wheel-result-title">{reasonText}</h2>
        <div className="wheel-result-score">
          <span className="wheel-result-score-num">{p.result.score}</span>
          <span className="wheel-result-score-lbl">doğru</span>
        </div>

        <div className="wheel-result-rows">
          <div className="wheel-result-row">
            <span>Süre</span>
            <strong>{durLabel}</strong>
          </div>
          <div className="wheel-result-row">
            <span>Kıta</span>
            <strong>{contLabel}</strong>
          </div>
          <div className="wheel-result-row">
            <span>Zorluk</span>
            <strong>{diffLabel}</strong>
          </div>
          <div className="wheel-result-row">
            <span>Can modu</span>
            <strong>{lifeLabel}</strong>
          </div>
          {p.lifeMode === "lives" && (
            <div className="wheel-result-row">
              <span>Kalan can</span>
              <strong>{p.result.livesLeft} / {MAX_LIVES}</strong>
            </div>
          )}
          {p.lifeMode === "endless" && (
            <div className="wheel-result-row">
              <span>Pas</span>
              <strong>{p.result.passCount}</strong>
            </div>
          )}
        </div>

        <div className="wheel-result-actions">
          <button
            type="button"
            className="wheel-ghost-btn"
            onClick={() => { playSound("click"); p.onHome(); }}
          >
            ⌂ Ana Menü
          </button>
          <button
            type="button"
            className="wheel-primary-btn"
            onClick={() => { playSound("click"); p.onReplay(); }}
          >
            ↺ Tekrar Oyna
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ROOT — WheelGame (single-screen)
═══════════════════════════════════════════════════════════════ */

interface WheelGameProps {
  onHome: () => void;
}

export default function WheelGame({ onHome }: WheelGameProps) {
  /* ── Settings (editable while !started) ── */
  const [continent,  setContinent]  = useState<ContinentFilter>("world");
  const [duration,   setDuration]   = useState<number>(60);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [lifeMode,   setLifeMode]   = useState<LifeMode>("lives");

  /* ── Game state ── */
  const [started,     setStarted]     = useState(false);
  const [finished,    setFinished]    = useState(false);
  const [finalResult, setFinalResult] = useState<GameOverResult | null>(null);

  const [score,       setScore]       = useState(0);
  const [livesLeft,   setLivesLeft]   = useState(INITIAL_LIVES);
  const [timeLeft,    setTimeLeft]    = useState(60);
  const [guessedISOs, setGuessedISOs] = useState<Set<string>>(new Set());
  const [lastGuessed, setLastGuessed] = useState<string | null>(null);
  // Passed targets — excluded from future spins so the same country
  // doesn't reappear, but NOT added to guessedISOs so the map doesn't
  // paint them green.
  const [passedISOs,  setPassedISOs]  = useState<Set<string>>(new Set());

  const [spinning,    setSpinning]    = useState(false);
  const [spinDisplay, setSpinDisplay] = useState("");
  const [target,      setTarget]      = useState<CountryEntry | null>(null);
  const [wrongId,     setWrongId]     = useState("");
  // Monotonic counter that increments on each life gain so the toast
  // re-animates even on rapid successive gains (used as React key).
  const [lifeGain,    setLifeGain]    = useState(0);

  /* ── Refs to avoid stale closures in async callbacks ── */
  const scoreRef        = useRef(0);
  const livesRef        = useRef(INITIAL_LIVES);
  const guessedRef      = useRef<Set<string>>(new Set());
  const passedRef       = useRef<Set<string>>(new Set());

  const spinIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spinFinishRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrongFlashRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifeGainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef          = useRef<number | null>(null);
  const startTimeRef    = useRef<number | null>(null);
  const endedRef        = useRef(false);
  const countdownPlayedRef = useRef(false);

  /* ── Pool & active scope ── */
  const pool      = useMemo(() => buildWheelPool(continent, difficulty), [continent, difficulty]);
  const activeIds = useMemo(() => getContinentIds(continent), [continent]);
  const remainingPool = useMemo(
    () => pool.filter((c) => !guessedISOs.has(c.topoId) && !passedISOs.has(c.topoId)),
    [pool, guessedISOs, passedISOs]
  );
  const poolEmpty = pool.length === 0;

  /* ── When idle, timer display mirrors selected duration ── */
  useEffect(() => {
    if (!started) setTimeLeft(duration);
  }, [duration, started]);

  /* ── Wall-clock timer: runs only while playing ── */
  useEffect(() => {
    if (!started || finished) return;

    if (!startTimeRef.current) {
      startTimeRef.current = Date.now();
    }
    const startTime = startTimeRef.current;
    const totalMs = duration * 1000;

    const tick = () => {
      if (endedRef.current) return;
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setTimeLeft(remaining);
      if (elapsed >= totalMs) {
        endGame("time");
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !endedRef.current) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, finished, duration]);

  /* ── Countdown sound (re-uses last10/last20 sound preference) ── */
  useEffect(() => {
    if (!started || finished) return;
    const mode = getCountdownSoundMode();
    const limit = mode === "last20" ? 20 : mode === "last10" ? 10 : 0;
    if (limit === 0 || duration <= limit) return;
    if (!shouldPlayCountdownSound(timeLeft, mode)) {
      countdownPlayedRef.current = false;
      stopSound("countdown20");
      return;
    }
    if (timeLeft > 0 && !countdownPlayedRef.current) {
      countdownPlayedRef.current = true;
      playSound("countdown20");
    }
    if (timeLeft <= 0) stopSound("countdown20");
  }, [timeLeft, started, finished, duration]);

  /* ── End game ── */
  const endGame = useCallback((reason: "time" | "lives" | "pool") => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (spinIntervalRef.current)  clearInterval(spinIntervalRef.current);
    if (spinFinishRef.current)    clearTimeout(spinFinishRef.current);
    if (wrongFlashRef.current)    clearTimeout(wrongFlashRef.current);
    if (lifeGainTimerRef.current) clearTimeout(lifeGainTimerRef.current);
    if (rafRef.current !== null)  cancelAnimationFrame(rafRef.current);
    stopSound("countdown20");
    setFinalResult({
      score:     scoreRef.current,
      livesLeft: livesRef.current,
      reason,
      passCount: passedRef.current.size,
    });
    setFinished(true);
    // Achievement stats: single-player wheel completed (daily streak +
    // distinct-mode count). Once-guarded by endedRef above.
    recordGameComplete({ modeFamily: "wheel" });
  }, []);

  /* ── Spin wheel (also starts the game on first call) ── */
  const handleSpin = useCallback(() => {
    if (spinning || finished) return;
    if (poolEmpty) return;
    if (remainingPool.length === 0) {
      endGame("pool");
      return;
    }

    playSound("click");

    if (!started) {
      setStarted(true);
    }

    setSpinning(true);
    setTarget(null);
    setWrongId("");

    const finalIdx = Math.floor(Math.random() * remainingPool.length);
    const finalTarget = remainingPool[finalIdx];
    const totalSpinMs = SPIN_MIN_MS + Math.random() * (SPIN_MAX_MS - SPIN_MIN_MS);

    spinIntervalRef.current = setInterval(() => {
      const randomIdx = Math.floor(Math.random() * remainingPool.length);
      setSpinDisplay(remainingPool[randomIdx]?.display ?? "");
    }, SPIN_TICK_MS);

    spinFinishRef.current = setTimeout(() => {
      if (spinIntervalRef.current) clearInterval(spinIntervalRef.current);
      spinIntervalRef.current = null;
      setSpinDisplay(finalTarget.display);
      setTarget(finalTarget);
      setSpinning(false);
    }, totalSpinMs);
  }, [spinning, finished, poolEmpty, remainingPool, started, endGame]);

  /* ── Handle country click on map ── */
  const handleCountryClick = useCallback(
    (topoId: string) => {
      if (endedRef.current) return;
      if (!target || spinning) return;
      if (guessedISOs.has(topoId)) return;

      if (topoId === target.topoId) {
        // Correct
        playSound("correct");
        setGuessedISOs((prev) => {
          const next = new Set(prev);
          next.add(topoId);
          guessedRef.current = next;
          return next;
        });
        setLastGuessed(topoId);
        setScore((s) => {
          const nx = s + 1;
          scoreRef.current = nx;
          return nx;
        });
        setTarget(null);
        setSpinDisplay("");

        // Life regen — only in "lives" mode, capped at MAX_LIVES.
        if (lifeMode === "lives") {
          const cur = livesRef.current;
          if (cur < MAX_LIVES) {
            const nx = cur + 1;
            livesRef.current = nx;
            setLivesLeft(nx);
            setLifeGain((g) => g + 1);
            if (lifeGainTimerRef.current) clearTimeout(lifeGainTimerRef.current);
            lifeGainTimerRef.current = setTimeout(
              () => setLifeGain(0),
              LIFE_GAIN_TOAST_MS
            );
          }
        }

        // If this guess emptied the pool → end with success
        if (remainingPool.length <= 1) {
          setTimeout(() => endGame("pool"), 400);
        }
      } else {
        // Wrong
        playSound("wrong");
        setWrongId(topoId);
        if (wrongFlashRef.current) clearTimeout(wrongFlashRef.current);
        wrongFlashRef.current = setTimeout(() => setWrongId(""), WRONG_FLASH_MS);

        if (lifeMode === "lives") {
          setLivesLeft((lv) => {
            const next = lv - 1;
            livesRef.current = next;
            if (next <= 0) {
              setTimeout(() => endGame("lives"), 350);
            }
            return next;
          });
        }
        // Endless mode: red flash only, no life loss, no game-over from lives.
      }
    },
    [target, spinning, guessedISOs, remainingPool.length, lifeMode, endGame]
  );

  /* ── Skip current target (endless mode only) ──
       Pas geçilen ülke passedISOs'a eklenir → bir daha çıkmaz.
       Skor değişmez, can değişmez, ülke guessedISOs'a eklenmez. */
  const handleSkip = useCallback(() => {
    if (endedRef.current || finished) return;
    if (lifeMode !== "endless") return;
    if (!target || spinning) return;

    playSound("click");

    const skippedId = target.topoId;
    setPassedISOs((prev) => {
      const next = new Set(prev);
      next.add(skippedId);
      passedRef.current = next;
      return next;
    });
    setTarget(null);
    setSpinDisplay("");
    if (wrongFlashRef.current) {
      clearTimeout(wrongFlashRef.current);
      setWrongId("");
    }

    // If skipping emptied the pool → end game
    if (remainingPool.length <= 1) {
      setTimeout(() => endGame("pool"), 400);
    }
  }, [lifeMode, target, spinning, finished, remainingPool.length, endGame]);

  /* ── Reset on Replay ── */
  const handleReplay = useCallback(() => {
    if (spinIntervalRef.current)  clearInterval(spinIntervalRef.current);
    if (spinFinishRef.current)    clearTimeout(spinFinishRef.current);
    if (wrongFlashRef.current)    clearTimeout(wrongFlashRef.current);
    if (lifeGainTimerRef.current) clearTimeout(lifeGainTimerRef.current);
    if (rafRef.current !== null)  cancelAnimationFrame(rafRef.current);
    spinIntervalRef.current  = null;
    spinFinishRef.current    = null;
    wrongFlashRef.current    = null;
    lifeGainTimerRef.current = null;
    rafRef.current           = null;
    startTimeRef.current     = null;
    endedRef.current         = false;
    countdownPlayedRef.current = false;
    scoreRef.current         = 0;
    livesRef.current         = INITIAL_LIVES;
    guessedRef.current       = new Set();
    passedRef.current        = new Set();

    setStarted(false);
    setFinished(false);
    setFinalResult(null);
    setScore(0);
    setLivesLeft(INITIAL_LIVES);
    setTimeLeft(duration);
    setGuessedISOs(new Set());
    setPassedISOs(new Set());
    setLastGuessed(null);
    setSpinning(false);
    setSpinDisplay("");
    setTarget(null);
    setWrongId("");
    setLifeGain(0);
  }, [duration]);

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      if (spinIntervalRef.current)  clearInterval(spinIntervalRef.current);
      if (spinFinishRef.current)    clearTimeout(spinFinishRef.current);
      if (wrongFlashRef.current)    clearTimeout(wrongFlashRef.current);
      if (lifeGainTimerRef.current) clearTimeout(lifeGainTimerRef.current);
      if (rafRef.current !== null)  cancelAnimationFrame(rafRef.current);
      stopSound("countdown20");
    };
  }, []);

  /* ── Derived display values ── */
  const settingsLocked = started || finished;

  const timerColor =
    !started
      ? "var(--accent)"
      : timeLeft > duration * 0.33
      ? "var(--accent)"
      : timeLeft > duration * 0.13
      ? "#f59e0b"
      : "#ef4444";
  const timerPct = (timeLeft / duration) * 100;
  const dashTotal = 106.8;
  const ringStyle: CSSProperties = {
    transform: "rotate(-90deg)",
    transformOrigin: "50% 50%",
    transition: "stroke-dashoffset 0.9s linear, stroke 0.4s",
  };

  /* ── Floating box content (shown when no target is locked in) ── */
  const showFloatingBox = !target;

  let floatingContent: JSX.Element | null = null;
  if (showFloatingBox) {
    if (poolEmpty) {
      floatingContent = (
        <>
          <span className="wheel-floating-title">⚠️ Havuz Boş</span>
          <span className="wheel-floating-desc">
            Bu ayarlar için ülke bulunamadı. Kıta veya zorluğu değiştir.
          </span>
        </>
      );
    } else if (spinning) {
      floatingContent = (
        <>
          <span className="wheel-floating-title">🎡 Çark dönüyor…</span>
          <span className="wheel-floating-name wheel-cycle">
            {spinDisplay || "—"}
          </span>
        </>
      );
    } else {
      // idle: initial OR between rounds
      floatingContent = (
        <>
          <span className="wheel-floating-title">🎡 Hazır</span>
          <span className="wheel-floating-desc">
            Çarkı çevir ve hedef ülkeyi bul.
          </span>
          <button
            type="button"
            className="wheel-primary-btn wheel-spin-btn"
            onClick={handleSpin}
            disabled={poolEmpty}
          >
            🎡 Çarkı Çevir
          </button>
        </>
      );
    }
  }

  return (
    <div className="wheel-app">
      {/* ── TOP BAR ── */}
      <div className="wheel-topbar">
        <div className="wheel-topbar-left">
          <button
            type="button"
            className="wheel-back-btn"
            onClick={() => { playSound("click"); onHome(); }}
            aria-label="Ana Menü"
          >
            ← Menü
          </button>
          {/* Desktop: dropdowns sit inline next to the back button. Hidden on
              mobile via CSS — see .wheel-topbar-dropdowns { display:none } in
              the mobile media query; on mobile the same controls are rendered
              inside <WheelMobileSettings /> below. */}
          <div className="wheel-topbar-dropdowns">
            <WheelDropdown
              options={CONTINENT_OPTIONS}
              value={continent}
              onChange={setContinent}
              disabled={settingsLocked}
              ariaLabel="Kıta"
            />
            <WheelDropdown
              options={DIFFICULTY_OPTIONS}
              value={difficulty}
              onChange={setDifficulty}
              disabled={settingsLocked}
              ariaLabel="Zorluk"
            />
            <WheelDropdown
              options={DURATION_OPTIONS}
              value={duration}
              onChange={setDuration}
              disabled={settingsLocked}
              ariaLabel="Süre"
            />
            <WheelDropdown
              options={LIFE_MODE_OPTIONS}
              value={lifeMode}
              onChange={setLifeMode}
              disabled={settingsLocked}
              ariaLabel="Can Modu"
            />
          </div>
          {/* Mobile-only gear button — opens the same dropdowns inside a panel. */}
          <WheelMobileSettings
            continent={continent} setContinent={setContinent}
            difficulty={difficulty} setDifficulty={setDifficulty}
            duration={duration} setDuration={setDuration}
            lifeMode={lifeMode} setLifeMode={setLifeMode}
            disabled={settingsLocked}
          />
        </div>

        <div className="wheel-topbar-center">
          {target && (
            <div className="wheel-topbar-target" aria-live="polite">
              <span className="wheel-topbar-target-label">🎯 Hedef:</span>
              <strong className="wheel-topbar-target-name">{target.display}</strong>
            </div>
          )}
          {target && lifeMode === "endless" && (
            <button
              type="button"
              className="wheel-topbar-skip"
              onClick={handleSkip}
              aria-label="Hedef ülkeyi pas geç"
            >
              ⏭️ Pas Geç
            </button>
          )}
        </div>

        <div className="wheel-topbar-right">
          <div className="wheel-hud-score">
            <span className="wheel-hud-label">Skor</span>
            <span className="wheel-hud-value">{score}</span>
          </div>
          <div
            className="wheel-hud-lives"
            aria-label={lifeMode === "endless" ? "Sınırsız can" : `${livesLeft} can`}
          >
            {lifeMode === "endless" ? (
              <span className="wheel-life-infinite" title="Sınırsız can">∞</span>
            ) : (
              Array.from({ length: MAX_LIVES }).map((_, i) => (
                <span key={i} className={"wheel-life" + (i < livesLeft ? " on" : " off")}>
                  {i < livesLeft ? "❤️" : "🖤"}
                </span>
              ))
            )}
            {lifeMode === "lives" && lifeGain > 0 && (
              <span key={lifeGain} className="wheel-life-gain" aria-live="polite">
                +1 can!
              </span>
            )}
          </div>
          <div className="wheel-hud-timer">
            <svg viewBox="0 0 42 42" className="wheel-timer-svg">
              <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
              <circle
                cx="21" cy="21" r="17" fill="none"
                stroke={timerColor} strokeWidth="3"
                strokeDasharray={String(dashTotal)}
                strokeDashoffset={dashTotal - (timerPct / 100) * dashTotal}
                strokeLinecap="round"
                style={ringStyle}
              />
            </svg>
            <span className="wheel-timer-num" style={{ color: timerColor }}>
              {timeLeft}
            </span>
          </div>
        </div>
      </div>

      {/* ── Map + floating overlay ── */}
      <div className="wheel-map-area">
        <WorldMap
          guessedISOs={guessedISOs}
          lastGuessed={lastGuessed}
          showLabels={false}
          activeIds={activeIds}
          resetKey={0}
          region={continent}
          onCountryClick={handleCountryClick}
          wrongId={wrongId || undefined}
        />
        {showFloatingBox && floatingContent && (
          <div className="wheel-floating-overlay">
            <div className="wheel-floating-box" role="dialog" aria-live="polite">
              {floatingContent}
            </div>
          </div>
        )}
      </div>

      {/* ── Result modal (overlay) ── */}
      {finished && finalResult && (
        <ResultScreen
          result={finalResult}
          duration={duration}
          continent={continent}
          difficulty={difficulty}
          lifeMode={lifeMode}
          onReplay={handleReplay}
          onHome={onHome}
        />
      )}
    </div>
  );
}
