import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import WorldMap, { SilhouetteView } from "./components/WorldMap";
import RouteGame from "./components/RouteGame";
import DuelGame from "./components/DuelGame";
import {
  NAME_TO_TOPOID,
  NAME_TO_ENTRY,
  TOPOID_TO_DISPLAY,
  normalizeInput,
  getContinentIds,
  getFlagPool,
  type Continent,
  type CountryEntry,
  type Difficulty,
} from "./data/countries";
import "./App.css";

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */
type AppScreen = "home" | "country-menu" | "map-game" | "flag-game" | "silhouette-game" | "route-game" | "duel-game";
type GameMode        = "idle" | "timed" | "free" | "finished";
type ContinentFilter = Continent | "world";

interface BestScore {
  score: number; total: number;
  continent: ContinentFilter; duration: number;
  gameType: AppScreen; date: string;
}

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════ */
const DURATION_OPTIONS = [
  { label: "15 sn", value: 15  },
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const CONTINENT_OPTIONS: { label: string; short: string; value: ContinentFilter }[] = [
  { label: "🌍 Dünya",     short: "Dünya",     value: "world"         },
  { label: "🇪🇺 Avrupa",   short: "Avrupa",    value: "europe"        },
  { label: "🌏 Asya",      short: "Asya",      value: "asia"          },
  { label: "🌍 Afrika",    short: "Afrika",    value: "africa"        },
  { label: "🌎 K.Amerika", short: "K.Amerika", value: "north-america" },
  { label: "🌎 G.Amerika", short: "G.Amerika", value: "south-america" },
  { label: "🌊 Okyanusya", short: "Okyanusya", value: "oceania"       },
];

const DIFFICULTY_OPTIONS: { label: string; value: Difficulty; color: string }[] = [
  { label: "🟢 Kolay",  value: "easy",   color: "var(--green)"  },
  { label: "🟡 Normal", value: "normal", color: "var(--amber)"  },
  { label: "🔴 Zor",    value: "hard",   color: "var(--red)"    },
  { label: "⚪ Tümü",   value: "all",    color: "var(--muted)"  },
];

/* ─── Gold ─── */
const GOLD_KEY       = "geoquiz_gold";
const GOLD_BONUS_KEY = "geoquiz_daily_bonus";
const DAILY_BONUS    = 50;

/** Per-correct-answer gold, awarded in bulk at game end. */
const GOLD_RATES: Record<AppScreen, number> = {
  "home": 0,
  "map-game": 2,
  "flag-game": 6,
  "silhouette-game": 8,
  "route-game": 0,
  "duel-game": 0,
  "country-menu": 0, // 🔥 bunu ekle
};

/** Hint costs */
const HINT_COSTS = {
  firstLetter: 15,
  continent:   20,
  letterCount: 25,
} as const;
type HintType = keyof typeof HINT_COSTS;

interface HintState {
  firstLetter: boolean;
  continent:   boolean;
  letterCount: boolean;
}
const EMPTY_HINTS: HintState = { firstLetter: false, continent: false, letterCount: false };

/* ─── Gold localStorage helpers ─── */
function loadGold(): number {
  try { return Math.max(0, parseInt(localStorage.getItem(GOLD_KEY) ?? "0", 10) || 0); }
  catch { return 0; }
}
function saveGold(n: number): void {
  try { localStorage.setItem(GOLD_KEY, String(Math.max(0, n))); } catch {}
}
function canClaimDailyBonus(): boolean {
  try {
    const last = localStorage.getItem(GOLD_BONUS_KEY);
    return !last || last !== new Date().toDateString();
  } catch { return true; }
}
function claimDailyBonus(): number {
  try { localStorage.setItem(GOLD_BONUS_KEY, new Date().toDateString()); } catch {}
  const next = loadGold() + DAILY_BONUS;
  saveGold(next);
  return next;
}

/* ─── BestScore localStorage helpers ─── */
const LS_KEY = "geoquiz_best_scores_v2";
function loadBests(): BestScore[] {
  try { const r = localStorage.getItem(LS_KEY); return r ? (JSON.parse(r) as BestScore[]) : []; }
  catch { return []; }
}
function saveBest(e: BestScore): BestScore[] {
  const all = loadBests();
  const key = e.gameType + "_" + e.continent + "_" + e.duration;
  const idx = all.findIndex(b => b.gameType + "_" + b.continent + "_" + b.duration === key);
  if (idx >= 0) { if (e.score > all[idx].score) all[idx] = e; } else all.push(e);
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
  return all;
}
function getBestForMode(gt: AppScreen, c: ContinentFilter, d: number): BestScore | null {
  return loadBests().find(b => b.gameType === gt && b.continent === c && b.duration === d) ?? null;
}

/* ─── Share helper ─── */
async function shareScore(
  score: number, total: number,
  continent: ContinentFilter, duration: number,
  gameType: AppScreen, difficulty?: Difficulty
): Promise<"shared" | "copied" | "failed"> {
  const pct     = Math.round((score / total) * 100);
  const cName   = CONTINENT_OPTIONS.find(c => c.value === continent)?.short ?? "Dünya";
  const dur     = DURATION_OPTIONS.find(d => d.value === duration)?.label ?? `${duration}sn`;
  const modeName =
    gameType === "flag-game"
      ? `Bayrak Modu${difficulty && difficulty !== "all" ? " (" + (DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label ?? "") + ")" : ""}`
      : gameType === "silhouette-game"
      ? `Silüet Modu${difficulty && difficulty !== "all" ? " (" + (DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label ?? "") + ")" : ""}`
      : "Ülke Yaz";
  const text = `GeoQuiz ${modeName} — ${cName} (${dur}): ${score}/${total} ülke — %${pct}. Sen geçebilir misin? 🌍`;
  if (typeof navigator.share === "function") {
    try { await navigator.share({ text }); return "shared"; } catch {}
  }
  try { await navigator.clipboard.writeText(text); return "copied"; }
  catch { return "failed"; }
}

/* ─── Shuffle ─── */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ═══════════════════════════════════════════════════════════════
   DROPDOWN
═══════════════════════════════════════════════════════════════ */
interface DropdownProps {
  label: string; disabled: boolean;
  children: React.ReactNode; align?: "left" | "right";
}
function Dropdown({ label, disabled, children, align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);
  return (
    <div className="dd-wrap" ref={ref}>
      <button
        className={"dd-trigger" + (open ? " open" : "") + (disabled ? " disabled" : "")}
        disabled={disabled} onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox" aria-expanded={open}
      >
        <span className="dd-label">{label}</span>
        <span className={"dd-caret" + (open ? " up" : "")}>▾</span>
      </button>
      {open && <div className={"dd-menu" + (align === "right" ? " dd-right" : "")} role="listbox">{children}</div>}
    </div>
  );
}
interface DDItemProps { active: boolean; onClick: () => void; children: React.ReactNode; }
function DDItem({ active, onClick, children }: DDItemProps) {
  return (
    <button className={"dd-item" + (active ? " active" : "")} role="option" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HOME SCREEN
═══════════════════════════════════════════════════════════════ */
interface HomeProps { onSelect: (screen: AppScreen) => void; }
function HomeScreen({ onSelect }: HomeProps) {
  const modes = [
  { id: "country-menu" as AppScreen, icon: "🌍", title: "Ülke Yaz", desc: "Tek oyuncu veya online oyna.", available: true },
  { id: "flag-game" as AppScreen, icon: "🚩", title: "Bayrak Modu", desc: "Bayrakları tanı! Her bayrak için ülke adını yaz.", available: true },
  { id: "silhouette-game" as AppScreen, icon: "🗺️", title: "Silüet Modu", desc: "Ülke şekillerini tanı! Silüetten tahmin et.", available: true },
  { id: "route-game" as AppScreen, icon: "🧭", title: "Rota Modu", desc: "Komşu ülkelerle hedefe ulaş.", available: true },
  { id: "home" as AppScreen, icon: "🌃", title: "Foto Tahmin", desc: "Fotoğraftan şehri veya ülkeyi bul.", available: false },
];
  return (
    <div className="home-screen">
      <div className="home-hero">
        <div className="home-globe">🌍</div>
        <h1 className="home-title">GeoQuiz</h1>
        <p className="home-subtitle">Dünya bilginizi test edin.</p>
      </div>
      <div className="mode-grid">
        {modes.map((m, i) => (
          <div key={i} className={"mode-card" + (m.available ? "" : " mode-card--soon")}>
            {!m.available && <span className="soon-badge">Yakında</span>}
            <div className="mode-card-icon">{m.icon}</div>
            <div className="mode-card-content">
              <h2 className="mode-card-title">{m.title}</h2>
              <p className="mode-card-desc">{m.desc}</p>
            </div>
            <button
              className={"btn btn-accent mode-card-btn" + (m.available ? "" : " disabled")}
              disabled={!m.available}
              onClick={() => m.available && onSelect(m.id)}
            >{m.available ? "Oyna" : "Yakında"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GOLD BAR
═══════════════════════════════════════════════════════════════ */
interface GoldBarProps {
  gold: number; canBonus: boolean; onClaimBonus: () => void;
}
function GoldBar({ gold, canBonus, onClaimBonus }: GoldBarProps) {
  return (
    <div className="gold-bar">
      <span className="gold-amount">
        <span className="gold-icon">🟡</span>
        <span className="gold-num">{gold}</span>
        <span className="gold-label">Gold</span>
      </span>
      {canBonus && (
        <button className="btn-bonus btn-sm" onClick={onClaimBonus} title="Günlük bonus al">
          +{DAILY_BONUS} Günlük Bonus
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HINT PANEL
═══════════════════════════════════════════════════════════════ */
interface HintPanelProps {
  gold: number;
  hints: HintState;
  currentEntry: CountryEntry | null;
  isPlaying: boolean;
  onBuyHint: (type: HintType) => void;
}
function HintPanel({ gold, hints, currentEntry, isPlaying, onBuyHint }: HintPanelProps) {
  if (!isPlaying || !currentEntry) return null;

  const display = currentEntry.display;
  const contOpt = CONTINENT_OPTIONS.find(c => c.value === currentEntry.continent);

  const defs: { type: HintType; label: string; cost: number; value: string }[] = [
    { type: "firstLetter", label: "İlk Harf",    cost: HINT_COSTS.firstLetter, value: display.charAt(0).toUpperCase() + "…"        },
    { type: "continent",   label: "Kıta",         cost: HINT_COSTS.continent,   value: contOpt?.label ?? currentEntry.continent      },
    { type: "letterCount", label: "Harf Sayısı",  cost: HINT_COSTS.letterCount, value: display.replace(/\s/g, "").length + " harf"  },
  ];

  return (
    <div className="hint-panel">
      <span className="hint-title">💡 İpucu:</span>
      {defs.map(h => {
        const bought     = hints[h.type];
        const affordable = gold >= h.cost;
        return (
          <div key={h.type} className={"hint-chip" + (bought ? " hint-bought" : "")}>
            {bought ? (
              <span className="hint-value">{h.value}</span>
            ) : (
              <button
                className={"btn-hint" + (affordable ? "" : " hint-broke")}
                disabled={!affordable}
                onClick={() => onBuyHint(h.type)}
                title={affordable ? `${h.cost} gold harca` : `Yetersiz gold (${h.cost} gerekli)`}
              >
                <span className="hint-label">{h.label}</span>
                <span className="hint-cost">🟡{h.cost}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULT MODAL
═══════════════════════════════════════════════════════════════ */
interface ModalProps {
  score: number; total: number; pct: number;
  continent: ContinentFilter; selectedDuration: number;
  lastMode: "timed" | "free"; gameType: AppScreen;
  difficulty?: Difficulty;
  currentBest: BestScore | null;
  missedCountries: string[]; missedFilter: string; filteredMissed: string[];
  shareState: "idle" | "shared" | "copied" | "failed";
  earnedGold: number;    // gold earned this session — shown in modal
  onMissedFilter: (v: string) => void;
  onClose: () => void; onReplay: () => void; onShare: () => void; onHome: () => void;
}
function ResultModal(p: ModalProps) {
  const isAllFound = p.score >= p.total && p.total > 0;
  const shareLabel = p.shareState === "shared" ? "✓ Paylaşıldı!" : p.shareState === "copied" ? "✓ Kopyalandı!" : p.shareState === "failed" ? "✗ Hata" : "📋 Sonucu Paylaş";
  const diffLabel  = p.difficulty && p.difficulty !== "all" ? DIFFICULTY_OPTIONS.find(d => d.value === p.difficulty)?.label : null;
  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-emoji">{isAllFound ? "🏆" : "⏰"}</div>
        <h2 className="modal-title">{isAllFound ? "Tebrikler!" : "Süre Doldu"}</h2>
        <div className="modal-score-wrap">
          <div className="modal-score-big">
            <span className="ms-num">{p.score}</span>
            <span className="ms-sep">/</span>
            <span className="ms-tot">{p.total}</span>
          </div>
          <div className="modal-pct-block">
            <span className="modal-pct">{p.pct}</span>
            <span className="modal-pct-sign">%</span>
          </div>
        </div>
        <div className="modal-bar-bg"><div className="modal-bar-fg" style={{ width: p.pct + "%" }} /></div>
        <p className="modal-context">
          {p.gameType === "flag-game" ? "🚩 Bayrak" : p.gameType === "silhouette-game" ? "🗺️ Silüet" : "🌍 Ülke Yaz"}
          {" · "}{CONTINENT_OPTIONS.find(c => c.value === p.continent)?.label}
          {diffLabel && <> · <span className="modal-diff">{diffLabel}</span></>}
          {" · "}{DURATION_OPTIONS.find(d => d.value === p.selectedDuration)?.label ?? p.selectedDuration + "sn"}
        </p>
        {/* Gold earned */}
        {p.earnedGold > 0 && (
          <div className="modal-gold-earned">
            <span className="modal-gold-icon">🟡</span>
            <span className="modal-gold-text">+{p.earnedGold} Gold kazandın!</span>
          </div>
        )}
        {p.currentBest && (
          <p className="modal-best">
            {p.score > p.currentBest.score
              ? "🎉 Yeni rekor!"
              : `En iyi: ${p.currentBest.score}/${p.currentBest.total} — ${DURATION_OPTIONS.find(d => d.value === p.currentBest!.duration)?.label} (${p.currentBest.date})`}
          </p>
        )}
        {p.missedCountries.length > 0 && (
          <div className="modal-missed">
            <div className="missed-header">
              <span className="missed-title">Bulunamayan <strong>{p.missedCountries.length}</strong> ülke</span>
              <input type="text" className="missed-search" placeholder="Filtrele…"
                value={p.missedFilter} onChange={e => p.onMissedFilter(e.target.value)} />
            </div>
            <div className="missed-list">
              {p.filteredMissed.length > 0
                ? p.filteredMissed.map(c => <span key={c} className="missed-chip">{c}</span>)
                : <span className="missed-empty">Sonuç yok</span>}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost"  onClick={p.onHome}>⌂ Ana Menü</button>
          <button className="btn btn-accent" onClick={p.onReplay}>↺ Tekrar</button>
          <button className={"btn btn-share" + (p.shareState !== "idle" ? " share-done" : "")} onClick={p.onShare}>{shareLabel}</button>
        </div>
        <button className="modal-close" onClick={p.onClose} aria-label="Kapat">✕</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TOP BAR
═══════════════════════════════════════════════════════════════ */
interface TopBarProps {
  gameType: AppScreen;
  score: number; total: number;
  mode: GameMode; isPlaying: boolean;
  continent: ContinentFilter; selectedDuration: number;
  timeLeft: number; timerPct: number; timerColor: string;
  lastMode: "timed" | "free";
  continentLabel: string; durationLabel: string; modeLabel: string;
  currentBest: BestScore | null;
  showLabels?: boolean;
  feedback: "correct" | "wrong" | "dup" | null;
  inputRef: React.RefObject<HTMLInputElement>;
  input: string; placeholder: string;
  difficulty?: Difficulty;
  onDifficultyChange?: (d: Difficulty) => void;
  onInput: (v: string) => void;
  onGuess: () => void;
  onSkip?: () => void;
  onReset: () => void; onHome: () => void;
  onStartGame: (m: "timed" | "free") => void;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onToggleLabels?: (v: boolean) => void;
  gold: number; canBonus: boolean; onClaimBonus: () => void;
}
function TopBar(p: TopBarProps) {
  const inputRowClass = ["bar-row bar-input", p.feedback ?? ""].filter(Boolean).join(" ");
  const diffOpt = p.difficulty ? DIFFICULTY_OPTIONS.find(d => d.value === p.difficulty) : null;
  return (
    <div className="control-bar">
      <GoldBar gold={p.gold} canBonus={p.canBonus} onClaimBonus={p.onClaimBonus} />
      {/* Row 1 */}
      <div className="bar-row bar-top">
        <button className="back-btn" onClick={p.onHome} title="Ana Menü">
          <span>←</span><span className="back-label">Menü</span>
        </button>
        <div className="bar-dropdowns">
          <Dropdown label={p.continentLabel} disabled={p.isPlaying}>
            {CONTINENT_OPTIONS.map(opt => (
              <DDItem key={opt.value} active={p.continent === opt.value}
                onClick={() => p.onContinentChange(opt.value)}>{opt.label}</DDItem>
            ))}
          </Dropdown>
          {(p.gameType === "flag-game" || p.gameType === "silhouette-game") && p.onDifficultyChange && (
            <Dropdown label={diffOpt?.label ?? "🟡 Normal"} disabled={p.isPlaying} align="right">
              <div className="dd-section-label">Zorluk</div>
              {DIFFICULTY_OPTIONS.map(opt => (
                <DDItem key={opt.value} active={p.difficulty === opt.value}
                  onClick={() => p.onDifficultyChange!(opt.value)}>{opt.label}</DDItem>
              ))}
            </Dropdown>
          )}
          <Dropdown label={"⏱ " + p.durationLabel} disabled={p.isPlaying} align="right">
            <div className="dd-section-label">Süre</div>
            {DURATION_OPTIONS.map(opt => (
              <DDItem key={opt.value} active={p.selectedDuration === opt.value}
                onClick={() => p.onDurationChange(opt.value)}>{opt.label}</DDItem>
            ))}
            <div className="dd-divider" />
            <div className="dd-section-label">Mod</div>
            <DDItem active={!p.isPlaying && p.lastMode === "free"}  onClick={() => { if (!p.isPlaying) p.onStartGame("free");  }}>∞ Serbest</DDItem>
            <DDItem active={!p.isPlaying && p.lastMode === "timed"} onClick={() => { if (!p.isPlaying) p.onStartGame("timed"); }}>⏱ Süreli</DDItem>
          </Dropdown>
        </div>
        <div className="bar-right">
          <div className="score-pill">
            <span className="score-n">{p.score}</span>
            <span className="score-sep">/</span>
            <span className="score-total">{p.total}</span>
            <span className="score-lbl">ülke</span>
          </div>
          {p.mode === "timed" && (
            <div className="timer-ring-wrap">
              <svg viewBox="0 0 42 42" className="timer-svg">
                <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
                <circle cx="21" cy="21" r="17" fill="none"
                  stroke={p.timerColor} strokeWidth="3"
                  strokeDasharray="106.8"
                  strokeDashoffset={106.8 - (p.timerPct / 100) * 106.8}
                  strokeLinecap="round"
                  style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
              </svg>
              <span className="timer-num" style={{ color: p.timerColor }}>{p.timeLeft}</span>
            </div>
          )}
        </div>
      </div>
      {/* Row 2: input */}
      <div className={inputRowClass}>
        <input ref={p.inputRef} type="text" className="guess-input"
          placeholder={p.placeholder} value={p.input} disabled={!p.isPlaying}
          onChange={e => p.onInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") p.onGuess(); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
        {p.isPlaying && (
          <>
            <button className="btn btn-accent" onClick={p.onGuess}>Gir</button>
            {p.onSkip && (
              <button className="btn btn-skip" onClick={p.onSkip} title="Pas Geç (ESC)">Pas</button>
            )}
            <button className="btn btn-ghost" onClick={p.onReset} title="Sıfırla">✕</button>
          </>
        )}
        {!p.isPlaying && p.mode !== "finished" && (
          <div className="start-btns">
            <button className="btn btn-accent btn-sm" onClick={() => p.onStartGame("free")}>∞ Serbest</button>
            <button className="btn btn-danger btn-sm" onClick={() => p.onStartGame("timed")}>⏱ Süreli</button>
          </div>
        )}
        {p.mode === "finished" && (
          <button className="btn btn-ghost" onClick={p.onReset}>✕</button>
        )}
      </div>
      {/* Row 3: feedback | best | toggle | diff badge */}
      <div className="bar-row bar-bottom">
        <div className="feedback-slot">
          {p.feedback === "correct" && <span className="fb fb-ok">✓ Doğru!</span>}
          {p.feedback === "wrong"   && <span className="fb fb-no">✗ Bulunamadı</span>}
          {p.feedback === "dup"     && <span className="fb fb-dup">Zaten bulundu</span>}
          {!p.isPlaying && p.mode !== "finished" && !p.feedback && (
            <span className="fb fb-hint">{p.continentLabel} · {p.durationLabel} · {p.modeLabel}</span>
          )}
        </div>
        {p.currentBest && (
          <div className="best-badge" title={"Tarih: " + p.currentBest.date}>
            <span className="best-icon">🏆</span>
            <span className="best-val">{p.currentBest.score}/{p.currentBest.total}</span>
            <span className="best-meta">
              {DURATION_OPTIONS.find(d => d.value === p.currentBest!.duration)?.label}
              {" · "}{CONTINENT_OPTIONS.find(c => c.value === p.currentBest!.continent)?.short}
            </span>
          </div>
        )}
        {p.gameType === "map-game" && p.onToggleLabels && (
          <label className="toggle-label">
            <input type="checkbox" className="toggle-cb"
              checked={p.showLabels ?? false} onChange={e => p.onToggleLabels!(e.target.checked)} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span className="toggle-text">İsimler</span>
          </label>
        )}
        {(p.gameType === "flag-game" || p.gameType === "silhouette-game") && p.isPlaying && p.difficulty && p.difficulty !== "all" && (
          <div className="diff-badge" style={{ borderColor: diffOpt?.color, color: diffOpt?.color }}>
            {diffOpt?.label}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GAME CORE HOOK
   Gold is tracked via refs during gameplay and only flushed to
   localStorage at game-end — this prevents the "re-adding reward
   on every render" bug and keeps hints properly scoped.
═══════════════════════════════════════════════════════════════ */
function useGameCore(gameType: AppScreen, continent: ContinentFilter, selectedDuration: number) {
  const [mode,         setMode]        = useState<GameMode>("idle");
  const [guessedISOs,  setGuessedISOs] = useState<Set<string>>(new Set());
  const [lastGuessed,  setLastGuessed] = useState<string | null>(null);
  const [input,        setInput]       = useState("");
  const [feedback,     setFeedback]    = useState<"correct" | "wrong" | "dup" | null>(null);
  const [timeLeft,     setTimeLeft]    = useState(selectedDuration);
  // Wall-clock start time — set when timed game begins, null otherwise.
  // Using Date.now() means the timer keeps running even when the tab is hidden.
  const gameStartTimeRef = useRef<number | null>(null);
  const rafRef           = useRef<number | null>(null);
  const [showModal,    setShowModal]   = useState(false);
  const [shareState,   setShareState]  = useState<"idle" | "shared" | "copied" | "failed">("idle");
  const [lastMode,     setLastMode]    = useState<"timed" | "free">("free");
  const [bests,        setBests]       = useState<BestScore[]>(() => loadBests());
  const [missedFilter, setMissedFilter] = useState("");

  // Gold: stored in localStorage, reflected in UI state
  const [gold,         setGold]        = useState<number>(() => loadGold());
  const [canBonus,     setCanBonus]    = useState<boolean>(() => canClaimDailyBonus());

  // Per-session gold tracking (not stored until game ends)
  const pendingGoldRef   = useRef(0);   // gold to be awarded this session
  const goldRewardedRef  = useRef(false); // prevent double-awarding per game

  const inputRef    = useRef<HTMLInputElement>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null); // kept for legacy cleanup
  const feedbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPlaying    = mode === "free" || mode === "timed";
  const activeIds    = useMemo(() => getContinentIds(continent), [continent]);
  const totalInScope = activeIds.size;
  const scoreInScope = useMemo(() => [...guessedISOs].filter(id => activeIds.has(id)).length, [guessedISOs, activeIds]);

  const missedCountries = useMemo(() => {
    if (mode !== "finished") return [];
    return [...activeIds]
      .filter(id => !guessedISOs.has(id) && TOPOID_TO_DISPLAY[id])
      .map(id => TOPOID_TO_DISPLAY[id])
      .sort((a, b) => a.localeCompare(b, "tr"));
  }, [mode, activeIds, guessedISOs]);

  const filteredMissed = useMemo(() => {
    const q = missedFilter.trim().toLowerCase();
    return q ? missedCountries.filter(c => c.toLowerCase().includes(q)) : missedCountries;
  }, [missedCountries, missedFilter]);

  const currentBest = useMemo(
    () => getBestForMode(gameType, continent, selectedDuration),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bests, continent, selectedDuration, gameType]
  );

  const triggerFeedback = useCallback((type: "correct" | "wrong" | "dup") => {
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    setFeedback(type);
    feedbackRef.current = setTimeout(() => setFeedback(null), 700);
  }, []);

  /** Accumulate pending gold for ONE correct answer (call from game components) */
  const addPendingGold = useCallback((hintUsed: boolean) => {
    const base = GOLD_RATES[gameType] ?? 0;
    const reward = hintUsed ? Math.floor(base * 0.5) : base;
    pendingGoldRef.current += reward;
  }, [gameType]);

  /** Flush pending gold to localStorage and state */
  const flushGold = useCallback(() => {
    if (goldRewardedRef.current) return; // already flushed this session
    goldRewardedRef.current = true;
    const pending = pendingGoldRef.current;
    if (pending > 0) {
      setGold(prev => {
        const next = prev + pending;
        saveGold(next);
        return next;
      });
    }
  }, []);

  const endGame = useCallback((won?: boolean) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null;
    void won;
    flushGold(); // award gold when game ends
    setMode("finished");
    setShowModal(true);
    setMissedFilter("");
  }, [flushGold]);

  // Save best score when mode becomes "finished"
  useEffect(() => {
    if (mode !== "finished") return;
    setBests(saveBest({
      score: scoreInScope, total: totalInScope,
      continent, duration: selectedDuration, gameType,
      date: new Date().toLocaleDateString("tr-TR"),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Real-time wall-clock timer ──
  // Uses Date.now() so it stays accurate even when the tab is hidden or
  // the browser throttles setInterval. A rAF loop checks the elapsed time
  // on every visible frame; visibilitychange re-checks on tab focus.
  useEffect(() => {
    if (mode !== "timed") return;

    // Record start time (or resume time if we re-enter this effect)
    if (!gameStartTimeRef.current) {
      gameStartTimeRef.current = Date.now();
    }
    const startTime    = gameStartTimeRef.current;
    const totalMs      = selectedDuration * 1000;
    let   ended        = false;

    const tick = () => {
      if (ended) return;
      const elapsed  = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setTimeLeft(remaining);
      if (elapsed >= totalMs) {
        ended = true;
        endGame();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    // Also fire on visibility restore so display snaps immediately
    const onVisible = () => {
      if (document.visibilityState === "visible" && !ended) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      ended = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mode, endGame, selectedDuration]);

  const startGame = useCallback((m: "timed" | "free") => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null; // will be set fresh when timed effect runs
    // Reset per-session gold tracking
    pendingGoldRef.current  = 0;
    goldRewardedRef.current = false;
    setLastMode(m);
    setGuessedISOs(new Set());
    setLastGuessed(null);
    setInput("");
    setFeedback(null);
    setTimeLeft(selectedDuration);
    setMode(m);
    setShowModal(false);
    setShareState("idle");
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [selectedDuration]);

  const resetGame = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null;
    pendingGoldRef.current  = 0;
    goldRewardedRef.current = false;
    setMode("idle");
    setGuessedISOs(new Set());
    setLastGuessed(null);
    setInput("");
    setFeedback(null);
    setTimeLeft(selectedDuration);
    setShowModal(false);
    setShareState("idle");
  }, [selectedDuration]);

  const handleClaimBonus = useCallback(() => {
    if (!canClaimDailyBonus()) return;
    const next = claimDailyBonus();
    setGold(next);
    setCanBonus(false);
  }, []);

  /** Spend gold for a hint (immediate deduction) */
  const spendGold = useCallback((amount: number) => {
    setGold(prev => {
      const next = Math.max(0, prev - amount);
      saveGold(next);
      return next;
    });
  }, []);

  const handleShare = useCallback(async (difficulty?: Difficulty) => {
    const result = await shareScore(scoreInScope, totalInScope, continent, selectedDuration, gameType, difficulty);
    setShareState(result);
    if (result !== "failed") setTimeout(() => setShareState("idle"), 2500);
  }, [scoreInScope, totalInScope, continent, selectedDuration, gameType]);

  return {
    mode, setMode, guessedISOs, setGuessedISOs, lastGuessed, setLastGuessed,
    input, setInput, feedback, triggerFeedback,
    timeLeft, showModal, setShowModal,
    shareState, lastMode, missedFilter, setMissedFilter,
    isPlaying, activeIds, totalInScope, scoreInScope, missedCountries, filteredMissed,
    currentBest, bests, inputRef, timerRef,
    gold, canBonus, spendGold, handleClaimBonus, addPendingGold,
    pendingGoldRef,
    startGame, resetGame, endGame, handleShare,
  };
}

/* ═══════════════════════════════════════════════════════════════
   MAP GAME
═══════════════════════════════════════════════════════════════ */
interface MapGameProps {
  continent: ContinentFilter; selectedDuration: number;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function MapGame({ continent, selectedDuration, onContinentChange, onDurationChange, onHome }: MapGameProps) {
  const g = useGameCore("map-game", continent, selectedDuration);
  const [showLabels, setShowLabels] = useState(false);
  const [mapResetKey, setMapResetKey] = useState(0);

  const handleGuess = () => {
    if (!g.isPlaying) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId || !g.activeIds.has(topoId)) {
  g.triggerFeedback("wrong");
  g.setInput(""); // 🔥 input temizlenir
  return;
}
    if (g.guessedISOs.has(topoId)) { g.triggerFeedback("dup"); g.setInput(""); return; }
    const next = new Set(g.guessedISOs);
    next.add(topoId);
    g.setGuessedISOs(next);
    g.setLastGuessed(topoId);
    g.setInput("");
    g.triggerFeedback("correct");
    g.addPendingGold(false); // map mode: no hints, no reduction
    if ([...next].filter(id => g.activeIds.has(id)).length >= g.totalInScope) g.endGame(true);
  };

  const handleContinentChange = (c: ContinentFilter) => {
    if (g.isPlaying) return;
    onContinentChange(c);
    setMapResetKey(k => k + 1);
  };
  const handleStartGame = (m: "timed" | "free") => { setMapResetKey(k => k + 1); g.startGame(m); };
  const handleReset = () => { setMapResetKey(k => k + 1); g.resetGame(); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = g.totalInScope > 0 ? Math.round((g.scoreInScope / g.totalInScope) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : "Ülke adı yaz… (Enter)";

  return (
    <div className="app">
      <TopBar
        gameType="map-game" score={g.scoreInScope} total={g.totalInScope}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} showLabels={showLabels} feedback={g.feedback}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onReset={handleReset} onHome={onHome}
        onStartGame={handleStartGame} onContinentChange={handleContinentChange}
        onDurationChange={onDurationChange} onToggleLabels={setShowLabels}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <div className="map-area">
        <WorldMap guessedISOs={g.guessedISOs} lastGuessed={g.lastGuessed}
          showLabels={showLabels} activeIds={g.activeIds} resetKey={mapResetKey}
          region={continent} />
      </div>
      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={g.scoreInScope} total={g.totalInScope} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType="map-game"
          currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare()}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FLAG GAME
═══════════════════════════════════════════════════════════════ */
interface FlagGameProps {
  continent: ContinentFilter; selectedDuration: number;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function FlagGame({ continent, selectedDuration, onContinentChange, onDurationChange, onHome }: FlagGameProps) {
  const g = useGameCore("flag-game", continent, selectedDuration);
  const [difficulty,  setDifficulty]  = useState<Difficulty>("normal");
  const [flagQueue,   setFlagQueue]   = useState<CountryEntry[]>([]);
  const [currentFlag, setCurrentFlag] = useState<CountryEntry | null>(null);
  const [flagIndex,   setFlagIndex]   = useState(0);
  const [imgError,    setImgError]    = useState(false);
  const [skipAnswer,  setSkipAnswer]  = useState<string | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hints are LOCAL to this component and strictly per-question.
  // We use a ref for the "key" so the state is always fresh when a new question arrives.
  const [hints, setHints] = useState<HintState>(EMPTY_HINTS);
  // Track whether ANY hint was used for the current question (for gold reduction)
  const hintUsedThisQRef = useRef(false);

  const resetHints = useCallback(() => {
    setHints(EMPTY_HINTS);
    hintUsedThisQRef.current = false;
  }, []);

  const handleBuyHint = useCallback((type: HintType) => {
    const cost = HINT_COSTS[type];
    if (g.gold < cost) return;
    g.spendGold(cost);
    setHints(prev => ({ ...prev, [type]: true }));
    hintUsedThisQRef.current = true;
  }, [g]);

  const flagPool  = useMemo(() => getFlagPool(continent, difficulty), [continent, difficulty]);
  const flagTotal = flagPool.length;
  const flagScore = useMemo(() => {
    const ids = new Set(flagPool.map(c => c.topoId).filter(Boolean));
    return [...g.guessedISOs].filter(id => ids.has(id)).length;
  }, [g.guessedISOs, flagPool]);

  const buildQueue = useCallback(() => {
    const q = shuffle([...flagPool]);
    setFlagQueue(q);
    setCurrentFlag(q[0] ?? null);
    setFlagIndex(0);
    setImgError(false);
    setSkipAnswer(null);
    resetHints();
  }, [flagPool, resetHints]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (g.isPlaying) buildQueue(); }, [g.mode]);

  const advanceTo = useCallback((pool: CountryEntry[], idx: number) => {
    const next = idx + 1;
    if (next < pool.length) {
      setCurrentFlag(pool[next]);
      setFlagIndex(next);
      setImgError(false);
    } else {
      g.endGame(false);
    }
    setSkipAnswer(null);
    resetHints(); // ← always reset hints when question changes
  }, [g, resetHints]);

  const handleSkip = useCallback(() => {
    if (!g.isPlaying || !currentFlag) return;
    if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
    setSkipAnswer(currentFlag.display);
    g.setInput("");
    skipTimerRef.current = setTimeout(() => advanceTo(flagQueue, flagIndex), 1500);
  }, [g, currentFlag, flagQueue, flagIndex, advanceTo]);

  useEffect(() => {
    if (!g.isPlaying) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") handleSkip(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [g.isPlaying, handleSkip]);

  const handleGuess = () => {
    if (!g.isPlaying || !currentFlag || skipAnswer !== null) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const entry = NAME_TO_ENTRY[norm];
    if (!entry || entry.code !== currentFlag.code) { 
  g.triggerFeedback("wrong"); 
  g.setInput(""); // input temizlenir
  return;
}
    const topoId = currentFlag.topoId;
    if (topoId && g.guessedISOs.has(topoId)) {
      g.triggerFeedback("dup"); g.setInput(""); advanceTo(flagQueue, flagIndex); return;
    }
    const next = new Set(g.guessedISOs);
    if (topoId) next.add(topoId);
    g.setGuessedISOs(next); g.setLastGuessed(topoId || null); g.setInput("");
    g.triggerFeedback("correct");
    g.addPendingGold(hintUsedThisQRef.current);
    advanceTo(flagQueue, flagIndex);
    const ids = new Set(flagPool.map(c => c.topoId).filter(Boolean));
    if ([...next].filter(id => ids.has(id)).length >= flagTotal) g.endGame(true);
  };

  const handleStartGame = (m: "timed" | "free") => { resetHints(); g.startGame(m); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = flagTotal > 0 ? Math.round((flagScore / flagTotal) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : skipAnswer !== null ? "Geçildi…" : "Bu bayrağın ülkesi? (Enter)";
  const flagSrc        = currentFlag ? `/assets/flags/${currentFlag.code}.svg` : "";
  const diffOpt        = DIFFICULTY_OPTIONS.find(d => d.value === difficulty);

  return (
    <div className="app">
      <TopBar
        gameType="flag-game" score={flagScore} total={flagTotal}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} feedback={g.feedback}
        difficulty={difficulty} onDifficultyChange={d => { if (!g.isPlaying) setDifficulty(d); }}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onSkip={handleSkip}
        onReset={g.resetGame} onHome={onHome}
        onStartGame={handleStartGame}
        onContinentChange={c => { if (!g.isPlaying) onContinentChange(c); }}
        onDurationChange={onDurationChange}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <HintPanel gold={g.gold} hints={hints} currentEntry={currentFlag} isPlaying={g.isPlaying} onBuyHint={handleBuyHint} />

      {/* Pas Geç bar — full-width, below hints, above flag display */}
      {g.isPlaying && (
        <div className="pas-gec-bar">
          {skipAnswer ? (
            <span className="pas-gec-answer">
              Doğru cevap: <strong>{skipAnswer}</strong>
            </span>
          ) : (
            <button className="btn-pas-gec" onClick={handleSkip}>
              <span>⏭️</span> Pas Geç
            </button>
          )}
          <span className="pas-gec-hint">ESC</span>
        </div>
      )}

      <div className="flag-area">
        {g.mode === "idle" && (
          <div className="flag-idle">
            <div className="flag-idle-icon">🚩</div>
            <p className="flag-idle-text">Bayrak Modu</p>
            <p className="flag-idle-sub">{diffOpt?.label} · {continentLabel} · {flagTotal} bayrak</p>
            <p className="flag-idle-sub" style={{ marginTop: "4px", fontSize: ".78rem", opacity: .6 }}>Başlamak için bir mod seç</p>
          </div>
        )}
        {g.isPlaying && currentFlag && (
          <div className="flag-stage">
            <div className="flag-meta-row">
              <span className="flag-progress">{flagIndex + 1} / {flagQueue.length}</span>
              <span className="flag-diff-pill" style={{ background: diffOpt?.color + "22", borderColor: diffOpt?.color, color: diffOpt?.color }}>{diffOpt?.label}</span>
            </div>
            <div className="flag-img-wrap">
              {imgError ? (
                <div className="flag-fallback">
                  <span className="flag-fallback-code">{currentFlag.code.toUpperCase()}</span>
                  <span className="flag-fallback-hint">Bayrak yüklenemedi</span>
                </div>
              ) : (
                <img key={currentFlag.code} src={flagSrc} alt="Bayrak" className="flag-img" onError={() => setImgError(true)} />
              )}
            </div>
            {skipAnswer ? (
              <div className="skip-answer-reveal">
                <span className="skip-label">Cevap:</span>
                <span className="skip-country">{skipAnswer}</span>
              </div>
            ) : (
              <p className="flag-prompt">Bu bayrağın ülkesi nedir?</p>
            )}
          </div>
        )}
        {g.mode === "finished" && (
          <div className="flag-idle">
            <div className="flag-idle-icon">{flagScore >= flagTotal ? "🏆" : "⏰"}</div>
            <p className="flag-idle-text">{flagScore >= flagTotal ? "Tebrikler!" : "Süre Doldu"}</p>
          </div>
        )}
      </div>

      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={flagScore} total={flagTotal} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType="flag-game"
          difficulty={difficulty} currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare(difficulty)}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SILHOUETTE GAME
═══════════════════════════════════════════════════════════════ */
interface SilhouetteGameProps {
  continent: ContinentFilter; selectedDuration: number;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function SilhouetteGame({ continent, selectedDuration, onContinentChange, onDurationChange, onHome }: SilhouetteGameProps) {
  const g = useGameCore("silhouette-game", continent, selectedDuration);
  const [difficulty,  setDifficulty]  = useState<Difficulty>("normal");
  const [silQueue,    setSilQueue]    = useState<CountryEntry[]>([]);
  const [currentSil,  setCurrentSil]  = useState<CountryEntry | null>(null);
  const [silIndex,    setSilIndex]    = useState(0);
  const [flash,       setFlash]       = useState<"correct" | "wrong" | null>(null);
  const [skipAnswer,  setSkipAnswer]  = useState<string | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Strictly per-question hint state
  const [hints, setHints] = useState<HintState>(EMPTY_HINTS);
  const hintUsedThisQRef  = useRef(false);

  const resetHints = useCallback(() => {
    setHints(EMPTY_HINTS);
    hintUsedThisQRef.current = false;
  }, []);

  const handleBuyHint = useCallback((type: HintType) => {
    const cost = HINT_COSTS[type];
    if (g.gold < cost) return;
    g.spendGold(cost);
    setHints(prev => ({ ...prev, [type]: true }));
    hintUsedThisQRef.current = true;
  }, [g]);

  const silPool  = useMemo(() => getFlagPool(continent, difficulty).filter(c => c.topoId), [continent, difficulty]);
  const silTotal = silPool.length;
  const silScore = useMemo(() => {
    const ids = new Set(silPool.map(c => c.topoId).filter(Boolean));
    return [...g.guessedISOs].filter(id => ids.has(id)).length;
  }, [g.guessedISOs, silPool]);

  const buildQueue = useCallback(() => {
    const q = shuffle([...silPool]);
    setSilQueue(q);
    setCurrentSil(q[0] ?? null);
    setSilIndex(0);
    setFlash(null);
    setSkipAnswer(null);
    resetHints();
  }, [silPool, resetHints]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (g.isPlaying) buildQueue(); }, [g.mode]);

  const advanceTo = useCallback((pool: CountryEntry[], idx: number) => {
    const next = idx + 1;
    if (next < pool.length) {
      setCurrentSil(pool[next]);
      setSilIndex(next);
      setFlash(null);
    } else {
      g.endGame(false);
    }
    setSkipAnswer(null);
    resetHints(); // ← always reset hints when question changes
  }, [g, resetHints]);

  const handleSkip = useCallback(() => {
    if (!g.isPlaying || !currentSil) return;
    if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
    setSkipAnswer(currentSil.display);
    setFlash("wrong");
    g.setInput("");
    skipTimerRef.current = setTimeout(() => {
      setFlash(null);
      advanceTo(silQueue, silIndex);
    }, 1500);
  }, [g, currentSil, silQueue, silIndex, advanceTo]);

  useEffect(() => {
    if (!g.isPlaying) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") handleSkip(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [g.isPlaying, handleSkip]);

  const handleGuess = () => {
    if (!g.isPlaying || !currentSil || skipAnswer !== null) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    const entry  = NAME_TO_ENTRY[norm];
    const isMatch = (topoId && topoId === currentSil.topoId) || (entry && entry.code === currentSil.code);
    if (!isMatch) {
  g.triggerFeedback("wrong");
  g.setInput(""); // 🔥 EKLE
  setFlash("wrong");
  setTimeout(() => setFlash(null), 500);
  return;
}
    const tid = currentSil.topoId;
    if (tid && g.guessedISOs.has(tid)) {
      g.triggerFeedback("dup"); g.setInput(""); advanceTo(silQueue, silIndex); return;
    }
    const next = new Set(g.guessedISOs);
    if (tid) next.add(tid);
    g.setGuessedISOs(next); g.setLastGuessed(tid || null); g.setInput("");
    g.triggerFeedback("correct");
    g.addPendingGold(hintUsedThisQRef.current);
    setFlash("correct");
    setTimeout(() => { setFlash(null); advanceTo(silQueue, silIndex); }, 600);
    const ids = new Set(silPool.map(c => c.topoId).filter(Boolean));
    if ([...next].filter(id => ids.has(id)).length >= silTotal) g.endGame(true);
  };

  const handleStartGame = (m: "timed" | "free") => { resetHints(); g.startGame(m); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = silTotal > 0 ? Math.round((silScore / silTotal) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : skipAnswer ? "Geçildi…" : "Hangi ülke? (Enter)";
  const diffOpt        = DIFFICULTY_OPTIONS.find(d => d.value === difficulty);

  return (
    <div className="app">
      <TopBar
        gameType={"silhouette-game" as AppScreen}
        score={silScore} total={silTotal}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} feedback={g.feedback}
        difficulty={difficulty} onDifficultyChange={d => { if (!g.isPlaying) setDifficulty(d); }}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onSkip={handleSkip}
        onReset={g.resetGame} onHome={onHome}
        onStartGame={handleStartGame}
        onContinentChange={c => { if (!g.isPlaying) onContinentChange(c); }}
        onDurationChange={onDurationChange}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <HintPanel gold={g.gold} hints={hints} currentEntry={currentSil} isPlaying={g.isPlaying} onBuyHint={handleBuyHint} />

      {/* Pas Geç bar */}
      {g.isPlaying && (
        <div className="pas-gec-bar">
          {skipAnswer ? (
            <span className="pas-gec-answer">
              Doğru cevap: <strong>{skipAnswer}</strong>
            </span>
          ) : (
            <button className="btn-pas-gec" onClick={handleSkip}>
              <span>⏭️</span> Pas Geç
            </button>
          )}
          <span className="pas-gec-hint">ESC</span>
        </div>
      )}

      <div className="sil-area">
        {g.mode === "idle" && (
          <div className="flag-idle">
            <div className="flag-idle-icon">🗺️</div>
            <p className="flag-idle-text">Silüet Modu</p>
            <p className="flag-idle-sub">{diffOpt?.label} · {continentLabel} · {silTotal} ülke</p>
            <p className="flag-idle-sub" style={{ marginTop: "4px", fontSize: ".78rem", opacity: .6 }}>Başlamak için bir mod seç</p>
          </div>
        )}
        {g.isPlaying && currentSil && (
          <div className="sil-stage">
            <div className="flag-meta-row">
              <span className="flag-progress">{silIndex + 1} / {silQueue.length}</span>
              <span className="flag-diff-pill" style={{ background: diffOpt?.color + "22", borderColor: diffOpt?.color, color: diffOpt?.color }}>{diffOpt?.label}</span>
            </div>
            <div className="sil-card">
              <SilhouetteView topoId={currentSil.topoId} flash={flash} />
            </div>
            {skipAnswer ? (
              <div className="skip-answer-reveal">
                <span className="skip-label">Cevap:</span>
                <span className="skip-country">{skipAnswer}</span>
              </div>
            ) : (
              <p className="flag-prompt">Bu ülkenin adı nedir?</p>
            )}
          </div>
        )}
        {g.mode === "finished" && (
          <div className="flag-idle">
            <div className="flag-idle-icon">{silScore >= silTotal ? "🏆" : "⏰"}</div>
            <p className="flag-idle-text">{silScore >= silTotal ? "Tebrikler!" : "Süre Doldu"}</p>
          </div>
        )}
      </div>

      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={silScore} total={silTotal} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType={"silhouette-game" as AppScreen}
          difficulty={difficulty} currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare(difficulty)}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen, setScreen] = useState<AppScreen>("home");
  const [continent, setContinent] = useState<ContinentFilter>("world");
  const [selectedDuration, setSelectedDuration] = useState(60);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("duel");

    if (code) {
      setScreen("duel-game");
    }
  }, []);

  if (screen === "home") return <HomeScreen onSelect={setScreen} />;
  if (screen === "country-menu") return (
  <div className="app">
    <div className="topbar">
      <button className="btn btn-ghost" onClick={() => setScreen("home")}>←</button>
      <h2>🌍 Ülke Yaz</h2>
    </div>

    <div className="mode-card">
      <h2>🎮 Tek Oyuncu</h2>
      <p>Haritada ülkeleri tek başına bul.</p>
      <button className="btn btn-accent" onClick={() => setScreen("map-game")}>Oyna</button>
    </div>

    <div className="mode-card">
      <h2>⚔️ Online 1v1</h2>
      <p>Online ülke kapmaca. Arkadaşınla veya rastgele rakiple oyna.</p>
      <button className="btn btn-accent" onClick={() => setScreen("duel-game")}>Oyna</button>
    </div>
  </div>
);
  if (screen === "duel-game") return <DuelGame onHome={() => setScreen("home")} />;
  if (screen === "route-game") return <RouteGame onHome={() => setScreen("home")} />;
  if (screen === "silhouette-game") return (
    <SilhouetteGame continent={continent} selectedDuration={selectedDuration}
      onContinentChange={setContinent} onDurationChange={setSelectedDuration}
      onHome={() => setScreen("home")} />
  );
  if (screen === "flag-game") return (
    <FlagGame continent={continent} selectedDuration={selectedDuration}
      onContinentChange={setContinent} onDurationChange={setSelectedDuration}
      onHome={() => setScreen("home")} />
  );
  return (
    <MapGame continent={continent} selectedDuration={selectedDuration}
      onContinentChange={setContinent} onDurationChange={setSelectedDuration}
      onHome={() => setScreen("home")} />
  );
}
