import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { playSound } from "../lib/sound";
import { RouteMapView } from "./WorldMap";
import {
  NORM_TO_ROUTE_KEY,
  COUNTRIES,
  getNeighbors,
  routeKeyToDisplay,
  normalizeInput,
  bfsPath,
  randomRouteTask,
  type RouteDifficulty,
} from "../data/countries";
import { useGold, addGold, spendGold as spendGoldStore } from "../lib/gold";
import { recordGameComplete } from "../lib/achievementStats";

/* ─── route reward dedup helpers ─── */
function buildRewardKey(start: string, target: string, diff: RouteDifficulty, shortest: number): string {
  return `routeReward:${start}:${target}:${diff}:${shortest}`;
}
function hasClaimedReward(start: string, target: string, diff: RouteDifficulty, shortest: number): boolean {
  try { return localStorage.getItem(buildRewardKey(start, target, diff, shortest)) === "1"; }
  catch { return false; }
}
function claimReward(start: string, target: string, diff: RouteDifficulty, shortest: number) {
  try { localStorage.setItem(buildRewardKey(start, target, diff, shortest), "1"); } catch {}
}

/* ─── constants ─── */
const HINT_COST_NEIGHBORS = 20;

const ROUTE_GOLD: Record<RouteDifficulty, { base: number; optimal: number }> = {
  easy:   { base:  3, optimal:  7 },
  normal: { base: 10, optimal: 20 },
  hard:   { base: 20, optimal: 40 },
};

const DIFF_LABELS: Record<RouteDifficulty, string> = {
  easy:   "🟢 Kolay (2–3 ülke)",
  normal: "🟡 Normal (4–5 ülke)",
  hard:   "🔴 Zor (6+ ülke)",
};

type RoutePhase = "setup" | "playing" | "won";

/* ─── Build key→topoId lookup (once) ─── */
function buildKeyToTopoId(): Record<string, string> {
  const map: Record<string, string> = {};
  COUNTRIES.forEach(entry => {
    for (const [norm, routeKey] of Object.entries(NORM_TO_ROUTE_KEY)) {
      if (
        (entry.names.some(n => normalizeInput(n) === norm) ||
         normalizeInput(entry.display) === norm) &&
        entry.topoId
      ) {
        map[routeKey] = entry.topoId;
      }
    }
  });
  return map;
}

/* ─── Joker state (per-question) ─── */
interface JokerState {
  neighborsRevealed: boolean;
}
const EMPTY_JOKER: JokerState = { neighborsRevealed: false };

interface RouteGameProps { onHome: () => void; }

export default function RouteGame({ onHome }: RouteGameProps) {
  const keyToTopoId = useMemo(buildKeyToTopoId, []);

  /* ── difficulty setup ── */
  const [difficulty, setDifficulty] = useState<RouteDifficulty>("normal");

  /* ── task — pick once on mount, store in state ── */
  const initialTask = useMemo(() => randomRouteTask("normal"), []);
  const [startKey,  setStartKey]  = useState<string>(initialTask.start);
  const [targetKey, setTargetKey] = useState<string>(initialTask.end);
  const [shortestPath, setShortestPath] = useState<string[]>(() => bfsPath(initialTask.start, initialTask.end) ?? []);

  /* ── game state ── */
  const [phase,         setPhase]        = useState<RoutePhase>("setup");
  const [route,         setRoute]        = useState<string[]>([]);
  const [input,         setInput]        = useState("");
  const [errMsg,        setErrMsg]       = useState<string | null>(null);
  const [okMsg,         setOkMsg]        = useState<string | null>(null);
  const gold = useGold();
  const [pendingGold,   setPendingGold]  = useState(0);
  const [joker,         setJoker]        = useState<JokerState>(EMPTY_JOKER);
  const [rewardClaimed, setRewardClaimed] = useState(false);
  const goldFlushedRef = useRef(false);

  const inputRef    = useRef<HTMLInputElement>(null);
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const okTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── generate a new task ── */
  const generateTask = useCallback((diff: RouteDifficulty) => {
    const task = randomRouteTask(diff);
    if (!task) {
      // Fallback – should never happen with the current graph
      setStartKey("Turkey");
      setTargetKey("Germany");
      setShortestPath(bfsPath("Turkey", "Germany") ?? []);
    } else {
      setStartKey(task.start);
      setTargetKey(task.end);
      setShortestPath(bfsPath(task.start, task.end) ?? []);
    }
  }, []);

  /* ── start game ── */
  const startGame = useCallback(() => {
    setRewardClaimed(hasClaimedReward(startKey, targetKey, difficulty, shortestPath.length - 1));
    setRoute([startKey]);
    setPhase("playing");
    setInput("");
    setErrMsg(null);
    setOkMsg(null);
    setPendingGold(0);
    setJoker(EMPTY_JOKER);
    goldFlushedRef.current = false;
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [startKey, targetKey, difficulty, shortestPath]);

  /* ── restart (pick new task, go back to setup) ── */
  const restartSetup = useCallback(() => {
    generateTask(difficulty);
    setPhase("setup");
    setRoute([]);
    setInput("");
    setErrMsg(null);
    setOkMsg(null);
    setPendingGold(0);
    setJoker(EMPTY_JOKER);
    goldFlushedRef.current = false;
  }, [difficulty, generateTask]);

  /* ── flush gold (once per game) ── */
  const flushGold = useCallback((extra: number) => {
    if (goldFlushedRef.current) return;
    goldFlushedRef.current = true;
    const total = pendingGold + extra;
    if (total > 0) {
      addGold(total, "route_match_reward");
    }
  }, [pendingGold]);

  /* ── feedback ── */
  const showErr = useCallback((msg: string) => {
    if (errTimerRef.current) clearTimeout(errTimerRef.current);
    setErrMsg(msg); setOkMsg(null);
    errTimerRef.current = setTimeout(() => setErrMsg(null), 2500);
  }, []);

  const showOk = useCallback((msg: string) => {
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
    setOkMsg(msg); setErrMsg(null);
    okTimerRef.current = setTimeout(() => setOkMsg(null), 900);
  }, []);

  /* ── derived ── */
  const currentKey   = route.length > 0 ? route[route.length - 1] : startKey;
  const neighbours   = getNeighbors(currentKey);
  const stepsCount   = route.length - 1;
  const startDisplay = routeKeyToDisplay(startKey);
  const targetDisplay = routeKeyToDisplay(targetKey);
  const curDisplay   = routeKeyToDisplay(currentKey);

  /* ── neighbor joker ── */
  const handleRevealNeighbors = useCallback(() => {
    if (joker.neighborsRevealed) return;
    if (!spendGoldStore(HINT_COST_NEIGHBORS, "hint_neighbors")) return;
    setJoker({ neighborsRevealed: true });
  }, [joker.neighborsRevealed]);

  /* Reset joker when moving to next country */
  const resetJoker = useCallback(() => {
    setJoker(EMPTY_JOKER);
  }, []);

  /* ── guess handler ── */
  const handleGuess = useCallback(() => {
    if (phase !== "playing") return;
    const norm = normalizeInput(input);
    if (!norm) return;

    const key = NORM_TO_ROUTE_KEY[norm];
    if (!key) { showErr("Bu ülke tanınmıyor."); playSound("wrong"); return; }
    if (key === currentKey) { showErr("Zaten bu ülkedesin."); playSound("wrong"); return; }
    if (!neighbours.includes(key)) {
      showErr(`"${routeKeyToDisplay(key)}" — ${curDisplay} ile komşu değil.`);
      playSound("wrong");
      return;
    }

    const newRoute = [...route, key];
    setRoute(newRoute);
    setInput("");
    resetJoker();

    if (key === targetKey || getNeighbors(key).includes(targetKey)) {
      const isOptimal = (newRoute.length - 1) <= (shortestPath.length - 2);
      if (!rewardClaimed) {
        const reward = ROUTE_GOLD[difficulty][isOptimal ? "optimal" : "base"];
        claimReward(startKey, targetKey, difficulty, shortestPath.length - 1);
        flushGold(reward);
      }
      setPhase("won");
      recordGameComplete({ modeFamily: "route" });
      playSound(isOptimal ? "win" : "lose");
    } else {
      showOk("✓ Doğru komşu!");
      playSound("correct");
    }
  }, [phase, input, route, neighbours, curDisplay, targetKey, shortestPath, rewardClaimed, startKey, difficulty, showErr, showOk, flushGold, resetJoker]);

  /* keyboard */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && phase === "playing") handleGuess();
      if (e.key === "Escape") setInput("");
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [handleGuess, phase]);

  /* ════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════ */
  const shortestLen   = shortestPath.length - 1;
  const wonByNeighbor = phase === "won" && currentKey !== targetKey;
  const wonOptimally  = stepsCount <= shortestLen - 1;
  const rewardAmount  = rewardClaimed ? 0 : ROUTE_GOLD[difficulty][wonOptimally ? "optimal" : "base"];

  const locationDesc = wonByNeighbor
    ? `${stepsCount} adımda ${curDisplay}'a ulaştın — ${targetDisplay}'ın komşusu`
    : `${stepsCount} adımda ${targetDisplay}'ya ulaştın`;
  const resultDesc = rewardClaimed
    ? " — Bu görev için ödül daha önce alındı. +0 gold"
    : wonOptimally
      ? ` — En kısa rotada tamamladın! +${rewardAmount} gold 🏆`
      : ` — Hedefe ulaştın ama en kısa rota kaçtı. +${rewardAmount} gold`;

  return (
    <div className="route-screen">

      {/* ══ TOP BAR ══ */}
      <div className="route-header">
        <button className="back-btn" onClick={onHome}>
          <span>←</span><span className="back-label">Menü</span>
        </button>

        <div className="route-title-block">
          <span className="route-mode-label">🧭 Rota Modu</span>
          {phase !== "setup" && (
            <span className="route-goal">
              <span className="route-start-label">{startDisplay}</span>
              <span className="route-arrow-big">→</span>
              <span className="route-target-label">{targetDisplay}</span>
            </span>
          )}
          {phase === "setup" && (
            <span className="route-goal">
              <span className="route-mode-label" style={{fontSize:".75rem"}}>Görev seçiliyor…</span>
            </span>
          )}
        </div>

        <div className="route-gold">
          <span className="gold-icon">🟡</span>
          <span className="gold-num">{gold}</span>
          <span className="gold-label">Gold</span>
        </div>
      </div>

      {/* ══ MAP ══ */}
      <div className="route-map-area">
        <RouteMapView
          routeKeys={phase === "setup" ? [startKey] : route}
          startKey={startKey}
          targetKey={targetKey}
          keyToTopoId={keyToTopoId}
        />
      </div>

      {/* ══ BOTTOM PANEL ══ */}
      <div className="route-bottom">

        {/* ── SETUP PHASE ── */}
        {phase === "setup" && (
          <div className="route-setup">
            <div className="route-setup-task">
              <span className="setup-lbl">Görev:</span>
              <span className="setup-start">{startDisplay}</span>
              <span className="setup-arrow">→</span>
              <span className="setup-target">{targetDisplay}</span>
              <span className="setup-dist">(en kısa: {shortestLen} adım)</span>
            </div>

            <div className="route-setup-controls">
              {/* Difficulty selector */}
              <div className="route-diff-row">
                {(["easy","normal","hard"] as RouteDifficulty[]).map(d => (
                  <button
                    key={d}
                    className={"route-diff-btn" + (difficulty === d ? " active" : "")}
                    onClick={() => { setDifficulty(d); if (phase === "setup") { const t = randomRouteTask(d); setStartKey(t.start); setTargetKey(t.end); setShortestPath(bfsPath(t.start, t.end) ?? []); } }}
                  >
                    {DIFF_LABELS[d]}
                  </button>
                ))}
              </div>

              <div className="route-setup-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => generateTask(difficulty)}>
                  🔀 Yeni Görev
                </button>
                <button className="btn btn-accent" onClick={startGame}>
                  Başla →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── PLAYING PHASE ── */}
        {phase === "playing" && (
          <>
            {/* Route path chips */}
            <div className="route-path-bar">
              <span className="route-path-meta">
                {stepsCount} adım &nbsp;·&nbsp; Şu an: <strong>{curDisplay}</strong>
              </span>
              <div className="route-path-chips">
                {route.map((key, i) => (
                  <span key={`${key}-${i}`} className="route-step-wrap">
                    <span className={
                      "route-step " + (
                        i === 0 ? "route-step-start" :
                        key === targetKey ? "route-step-win" :
                        i === route.length - 1 ? "route-step-current" :
                        "route-step-visited"
                      )
                    }>
                      {routeKeyToDisplay(key)}
                    </span>
                    {i < route.length - 1 && <span className="route-chevron">›</span>}
                  </span>
                ))}
                {route[route.length - 1] !== targetKey && (
                  <span className="route-step-wrap">
                    <span className="route-chevron">›</span>
                    <span className="route-step route-step-ghost">{targetDisplay}?</span>
                  </span>
                )}
              </div>
            </div>

            {/* Input row */}
            <div className={"route-input-row " + (errMsg ? "err" : okMsg ? "ok" : "")}>
              <input
                ref={inputRef}
                type="text"
                className="route-input"
                placeholder={`${curDisplay} ile komşu ülke yaz… (Enter)`}
                value={input}
                onChange={e => setInput(e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
              />
              <button className="btn btn-accent" onClick={handleGuess}>Gir</button>
            </div>

            {/* Feedback + neighbor joker row */}
            <div className="route-action-row">
              <div className="route-feedback-slot">
                {errMsg && <span className="route-msg route-msg-err">⚠ {errMsg}</span>}
                {okMsg  && <span className="route-msg route-msg-ok">{okMsg}</span>}
                {!errMsg && !okMsg && joker.neighborsRevealed && (
                  <span className="route-nb-hint">
                    <strong>Komşular:</strong>{" "}
                    {neighbours.map(routeKeyToDisplay).join(", ")}
                  </span>
                )}
              </div>

              {/* Neighbor joker button */}
              {!joker.neighborsRevealed ? (
                <button
                  className={"btn-route-joker" + (gold < HINT_COST_NEIGHBORS ? " joker-broke" : "")}
                  disabled={gold < HINT_COST_NEIGHBORS}
                  onClick={handleRevealNeighbors}
                  title={gold < HINT_COST_NEIGHBORS ? `Yetersiz gold (${HINT_COST_NEIGHBORS} gerekli)` : undefined}
                >
                  👁 Komşuları Göster
                  <span className="joker-cost">🟡{HINT_COST_NEIGHBORS}</span>
                </button>
              ) : (
                <span className="joker-used-badge">👁 Komşular açık</span>
              )}
            </div>
          </>
        )}

        {/* ── WON PHASE ── */}
        {phase === "won" && (
          <div className="route-win-inline">
            <div className="route-win-header">
              <span className="route-win-emoji">{wonOptimally ? "🎉" : "😓"}</span>
              <div className="route-win-text">
                <p className="route-win-title">{wonOptimally ? "Başardın!" : "Rota Tamamlandı"}</p>
                <p className="route-win-steps">{locationDesc}{resultDesc}</p>
              </div>
              {rewardClaimed ? (
                <span className="route-reward-claimed-note">+0 gold</span>
              ) : (
                <div className="route-win-gold-badge">
                  <span>🟡</span>
                  <span>+{rewardAmount}</span>
                </div>
              )}
            </div>

            {/* Optimal path if not found */}
            {stepsCount > shortestLen && (
              <div className="route-optimal">
                <span className="route-optimal-label">En kısa rota:</span>
                <div className="route-path-chips route-optimal-chips">
                  {shortestPath.map((key, i) => (
                    <span key={key} className="route-step-wrap">
                      <span className={
                        "route-step " + (
                          i === 0 ? "route-step-start" :
                          i === shortestPath.length - 1 ? "route-step-win" :
                          "route-step-visited"
                        )
                      }>
                        {routeKeyToDisplay(key)}
                      </span>
                      {i < shortestPath.length - 1 && <span className="route-chevron">›</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Completed route */}
            <div className="route-path-chips route-win-chips">
              {route.map((key, i) => (
                <span key={`${key}-${i}`} className="route-step-wrap">
                  <span className={
                    "route-step " + (
                      i === 0 ? "route-step-start" :
                      key === targetKey ? "route-step-win" :
                      "route-step-visited"
                    )
                  }>
                    {routeKeyToDisplay(key)}
                  </span>
                  {i < route.length - 1 && <span className="route-chevron">›</span>}
                </span>
              ))}
            </div>

            <div className="route-win-actions">
              <button className="btn btn-ghost  btn-sm" onClick={restartSetup}>🔀 Yeni Görev</button>
              <button className="btn btn-accent btn-sm" onClick={startGame}>↺ Aynı Görevi Tekrar</button>
              <button className="btn btn-ghost  btn-sm" onClick={onHome}>⌂ Menü</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
