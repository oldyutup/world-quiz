import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import WorldMap from "./components/WorldMap";
import {
  NAME_TO_TOPOID,
  TOPOID_TO_DISPLAY,
  normalizeInput,
  getContinentIds,
  type Continent,
} from "./data/countries";
import "./App.css";

/* ── types ── */
type GameMode = "idle" | "timed" | "free" | "finished";
type ContinentFilter = Continent | "world";

interface BestScore {
  score:     number;
  total:     number;
  continent: ContinentFilter;
  duration:  number;
  date:      string;
}

/* ── constants ── */
const DURATION_OPTIONS = [
  { label: "15 sn", value: 15  },
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const CONTINENT_OPTIONS: { label: string; short: string; value: ContinentFilter }[] = [
  { label: "🌍 Dünya",     short: "Dünya",     value: "world"    },
  { label: "🇪🇺 Avrupa",   short: "Avrupa",    value: "europe"   },
  { label: "🌏 Asya",      short: "Asya",      value: "asia"     },
  { label: "🌍 Afrika",    short: "Afrika",    value: "africa"   },
  { label: "🌎 Amerika",   short: "Amerika",   value: "americas" },
  { label: "🌊 Okyanusya", short: "Okyanusya", value: "oceania"  },
];

const LS_KEY = "geoquiz_best_scores";

/* ── localStorage ── */
function loadBests(): BestScore[] {
  try { const r = localStorage.getItem(LS_KEY); return r ? (JSON.parse(r) as BestScore[]) : []; }
  catch { return []; }
}
function saveBest(entry: BestScore): BestScore[] {
  const all = loadBests();
  const key = entry.continent + "_" + entry.duration;
  const idx = all.findIndex(b => b.continent + "_" + b.duration === key);
  if (idx >= 0) { if (entry.score > all[idx].score) all[idx] = entry; }
  else all.push(entry);
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
  return all;
}
function getBestForMode(continent: ContinentFilter, duration: number): BestScore | null {
  return loadBests().find(b => b.continent === continent && b.duration === duration) ?? null;
}

/* ── share helper: navigator.share first, then clipboard ── */
async function shareScore(
  score: number, total: number,
  continent: ContinentFilter, duration: number
): Promise<"shared" | "copied" | "failed"> {
  const pct   = Math.round((score / total) * 100);
  const cOpt  = CONTINENT_OPTIONS.find(c => c.value === continent);
  const cName = cOpt?.short ?? "Dünya";
  const dur   = DURATION_OPTIONS.find(d => d.value === duration)?.label ?? `${duration}sn`;
  const text  = `GeoQuiz'de ${cName} (${dur}): ${score}/${total} ülke — %${pct}. Sen geçebilir misin? 🌍`;
  if (typeof navigator.share === "function") {
    try { await navigator.share({ text }); return "shared"; } catch {}
  }
  try { await navigator.clipboard.writeText(text); return "copied"; }
  catch { return "failed"; }
}

/* ═══════════════════════════════════════════════════════
   APP
═══════════════════════════════════════════════════════ */
export default function App() {
  const [mode,             setMode]             = useState<GameMode>("idle");
  const [guessedISOs,      setGuessedISOs]      = useState<Set<string>>(new Set());
  const [lastGuessed,      setLastGuessed]      = useState<string | null>(null);
  const [input,            setInput]            = useState("");
  const [feedback,         setFeedback]         = useState<"correct" | "wrong" | "dup" | null>(null);
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [timeLeft,         setTimeLeft]         = useState(60);
  const [showLabels,       setShowLabels]       = useState(false);
  const [continent,        setContinent]        = useState<ContinentFilter>("world");
  const [showModal,        setShowModal]        = useState(false);
  const [shareState,       setShareState]       = useState<"idle" | "shared" | "copied" | "failed">("idle");
  const [lastMode,         setLastMode]         = useState<"timed" | "free">("free");
  const [bests,            setBests]            = useState<BestScore[]>(() => loadBests());
  const [missedFilter,     setMissedFilter]     = useState("");

  const inputRef    = useRef<HTMLInputElement>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPlaying = mode === "free" || mode === "timed";

  /* active IDs for current continent */
  const activeIds    = useMemo(() => getContinentIds(continent), [continent]);
  const totalInScope = activeIds.size;

  const scoreInScope = useMemo(
    () => [...guessedISOs].filter(id => activeIds.has(id)).length,
    [guessedISOs, activeIds]
  );

  /* missed — alphabetical, filtered by search */
  const missedCountries = useMemo(() => {
    if (mode !== "finished") return [];
    return [...activeIds]
      .filter(id => !guessedISOs.has(id) && TOPOID_TO_DISPLAY[id])
      .map(id => TOPOID_TO_DISPLAY[id])
      .sort((a, b) => a.localeCompare(b, "tr"));
  }, [mode, activeIds, guessedISOs]);

  const filteredMissed = useMemo(() => {
    const q = missedFilter.trim().toLowerCase();
    if (!q) return missedCountries;
    return missedCountries.filter(c => c.toLowerCase().includes(q));
  }, [missedCountries, missedFilter]);

  /* best for current settings */
  const currentBest = useMemo(
    () => getBestForMode(continent, selectedDuration),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bests, continent, selectedDuration]
  );

  /* feedback with shake/pulse on input */
  const triggerFeedback = (type: "correct" | "wrong" | "dup") => {
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    setFeedback(type);
    feedbackRef.current = setTimeout(() => setFeedback(null), 700);
  };

  /* end game */
  const endGame = useCallback((won?: boolean) => {
    if (timerRef.current) clearInterval(timerRef.current);
    void won;
    setMode("finished");
    setShowModal(true);
    setMissedFilter("");
  }, []);

  /* save best */
  useEffect(() => {
    if (mode !== "finished") return;
    const entry: BestScore = {
      score:    scoreInScope,
      total:    totalInScope,
      continent,
      duration: selectedDuration,
      date:     new Date().toLocaleDateString("tr-TR"),
    };
    setBests(saveBest(entry));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* timer */
  useEffect(() => {
    if (mode !== "timed") return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => { if (t <= 1) { endGame(); return 0; } return t - 1; });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mode, endGame]);

  /* guess */
  const handleGuess = () => {
    if (!isPlaying) return;
    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId || !activeIds.has(topoId)) { triggerFeedback("wrong"); return; }
    if (guessedISOs.has(topoId)) { triggerFeedback("dup"); setInput(""); return; }
    const next = new Set(guessedISOs);
    next.add(topoId);
    setGuessedISOs(next);
    setLastGuessed(topoId);
    setInput("");
    triggerFeedback("correct");
    if ([...next].filter(id => activeIds.has(id)).length >= totalInScope) endGame(true);
  };

  /* start */
  const startGame = (m: "timed" | "free") => {
    if (timerRef.current) clearInterval(timerRef.current);
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
  };

  /* reset */
  const resetGame = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setMode("idle");
    setGuessedISOs(new Set());
    setLastGuessed(null);
    setInput("");
    setFeedback(null);
    setTimeLeft(selectedDuration);
    setShowModal(false);
    setShareState("idle");
  };

  /* share */
  const handleShare = async () => {
    const result = await shareScore(scoreInScope, totalInScope, continent, selectedDuration);
    setShareState(result);
    if (result !== "failed") setTimeout(() => setShareState("idle"), 2500);
  };

  /* derived */
  const timerPct   = (timeLeft / selectedDuration) * 100;
  const timerColor = timeLeft > selectedDuration * 0.33 ? "var(--accent)"
    : timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";

  const pct        = totalInScope > 0 ? Math.round((scoreInScope / totalInScope) * 100) : 0;
  const isAllFound = scoreInScope >= totalInScope && totalInScope > 0;

  const shareLabel =
    shareState === "shared" ? "✓ Paylaşıldı!" :
    shareState === "copied" ? "✓ Kopyalandı!" :
    shareState === "failed" ? "✗ Hata" :
    "📋 Sonucu Paylaş";

  const placeholder =
    mode === "idle"     ? "Önce bir mod seç" :
    mode === "finished" ? "Oyun bitti"        :
                          "Ülke adı yaz… (Enter)";

  /* input class: adds shake on wrong, pulse on correct */
  const inputRowClass = ["bar-row bar-input", feedback ?? ""].filter(Boolean).join(" ");

  /* ══════════════════════════════════════ RENDER */
  return (
    <div className="app">

      {/* ─── CONTROL BAR ─── */}
      <div className="control-bar">

        {/* Row 1 — brand | continent tabs | score | timer */}
        <div className="bar-row bar-top">
          <div className="brand">
            <span className="brand-globe">🌍</span>
            <span className="brand-name">GeoQuiz</span>
          </div>

          <div className="continent-tabs">
            {CONTINENT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={"ctab" + (continent === opt.value ? " active" : "")}
                disabled={isPlaying}
                onClick={() => setContinent(opt.value)}
              >{opt.label}</button>
            ))}
          </div>

          <div className="bar-right">
            <div className="score-pill">
              <span className="score-n">{scoreInScope}</span>
              <span className="score-sep">/</span>
              <span className="score-total">{totalInScope}</span>
              <span className="score-lbl">ülke</span>
            </div>

            {mode === "timed" && (
              <div className="timer-ring-wrap">
                <svg viewBox="0 0 42 42" className="timer-svg">
                  <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
                  <circle cx="21" cy="21" r="17" fill="none"
                    stroke={timerColor} strokeWidth="3"
                    strokeDasharray="106.8"
                    strokeDashoffset={106.8 - (timerPct / 100) * 106.8}
                    strokeLinecap="round"
                    style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
                </svg>
                <span className="timer-num" style={{ color: timerColor }}>{timeLeft}</span>
              </div>
            )}
          </div>
        </div>

        {/* Row 2 — input */}
        <div className={inputRowClass}>
          <input
            ref={inputRef}
            type="text" className="guess-input"
            placeholder={placeholder}
            value={input} disabled={!isPlaying}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleGuess(); }}
            autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          />
          {isPlaying && (
            <>
              <button className="btn btn-accent" onClick={handleGuess}>Gir</button>
              <button className="btn btn-ghost"  onClick={resetGame} title="Sıfırla">✕</button>
            </>
          )}
          {mode === "finished" && (
            <button className="btn btn-ghost" onClick={resetGame} title="Ana menü">✕</button>
          )}
        </div>

        {/* Row 3 — feedback | duration | modes | best | toggle */}
        <div className="bar-row bar-bottom">
          <div className="feedback-slot">
            {feedback === "correct" && <span className="fb fb-ok">✓ Doğru!</span>}
            {feedback === "wrong"   && <span className="fb fb-no">✗ Bulunamadı</span>}
            {feedback === "dup"     && <span className="fb fb-dup">Zaten bulundu</span>}
          </div>

          {!isPlaying && (
            <div className="duration-row">
              {DURATION_OPTIONS.map(opt => (
                <button key={opt.value}
                  className={"dur-btn" + (selectedDuration === opt.value ? " active" : "")}
                  onClick={() => setSelectedDuration(opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {(mode === "idle" || mode === "finished") && (
            <div className="mode-btns">
              <button className="btn btn-accent btn-sm" onClick={() => startGame("free")}>∞ Serbest</button>
              <button className="btn btn-danger btn-sm" onClick={() => startGame("timed")}>⏱ Süreli</button>
            </div>
          )}

          {/* Best score badge — shows score / total — duration — continent */}
          {currentBest && (
            <div className="best-badge" title={"Tarih: " + currentBest.date}>
              <span className="best-icon">🏆</span>
              <span className="best-val">
                {currentBest.score}/{currentBest.total}
              </span>
              <span className="best-meta">
                {DURATION_OPTIONS.find(d => d.value === currentBest.duration)?.label ?? currentBest.duration + "sn"}
                {" · "}
                {CONTINENT_OPTIONS.find(c => c.value === currentBest.continent)?.short ?? currentBest.continent}
              </span>
            </div>
          )}

          <label className="toggle-label">
            <input type="checkbox" className="toggle-cb"
              checked={showLabels} onChange={e => setShowLabels(e.target.checked)} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span className="toggle-text">İsimler</span>
          </label>
        </div>
      </div>

      {/* ─── MAP ─── */}
      <div className="map-area">
        <WorldMap
          guessedISOs={guessedISOs}
          lastGuessed={lastGuessed}
          showLabels={showLabels}
          activeIds={activeIds}
        />
      </div>

      {/* ─── RESULT MODAL ─── */}
      {showModal && mode === "finished" && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="modal-emoji">{isAllFound ? "🏆" : "⏰"}</div>
            <h2 className="modal-title">{isAllFound ? "Tebrikler!" : "Süre Doldu"}</h2>

            {/* Score block */}
            <div className="modal-score-wrap">
              <div className="modal-score-big">
                <span className="ms-num">{scoreInScope}</span>
                <span className="ms-sep">/</span>
                <span className="ms-tot">{totalInScope}</span>
              </div>
              <div className="modal-pct-block">
                <span className="modal-pct">{pct}</span>
                <span className="modal-pct-sign">%</span>
              </div>
            </div>

            {/* Progress bar */}
            <div className="modal-bar-bg">
              <div
                className="modal-bar-fg"
                style={{ width: pct + "%" }}
                data-pct={pct}
              />
            </div>

            {/* Context line */}
            <p className="modal-context">
              {CONTINENT_OPTIONS.find(c => c.value === continent)?.label}
              {" · "}
              {DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? selectedDuration + "sn"}
            </p>

            {/* Best score line */}
            {currentBest && (
              <p className="modal-best">
                {scoreInScope > currentBest.score
                  ? "🎉 Yeni rekor!"
                  : `En iyi: ${currentBest.score}/${currentBest.total} — ${DURATION_OPTIONS.find(d => d.value === currentBest.duration)?.label} — ${CONTINENT_OPTIONS.find(c => c.value === currentBest.continent)?.short} (${currentBest.date})`}
              </p>
            )}

            {/* Missed countries — search + scrollable list */}
            {missedCountries.length > 0 && (
              <div className="modal-missed">
                <div className="missed-header">
                  <span className="missed-title">
                    Bulunamayan <strong>{missedCountries.length}</strong> ülke
                  </span>
                  <input
                    type="text"
                    className="missed-search"
                    placeholder="Filtrele…"
                    value={missedFilter}
                    onChange={e => setMissedFilter(e.target.value)}
                  />
                </div>
                <div className="missed-list">
                  {filteredMissed.length > 0
                    ? filteredMissed.map(c => <span key={c} className="missed-chip">{c}</span>)
                    : <span className="missed-empty">Sonuç yok</span>}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="modal-actions">
              <button className="btn btn-accent" onClick={() => startGame(lastMode)}>
                ↺ Tekrar Oyna
              </button>
              <button
                className={"btn btn-share" + (shareState !== "idle" ? " share-done" : "")}
                onClick={handleShare}
              >
                {shareLabel}
              </button>
            </div>

            <button className="modal-close" onClick={() => setShowModal(false)} aria-label="Kapat">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
