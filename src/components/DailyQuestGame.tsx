/**
 * DailyQuestGame.tsx — Günün Görevi oyun ekranı (4 mod, sunucu-otoriter).
 *
 * Normal solo modlara DOKUNMADAN, mevcut sunum parçalarını (WorldMap /
 * RouteMapView / bayrak SVG'leri / route-step chip dili) yeniden kullanan
 * İZOLE görev oturumu yüzeyi:
 *
 *   • Ayarlar KİLİTLİ — hepsi sunucudan gelen session.config'tir; bu ekranda
 *     hiçbir ayar kontrolü yoktur.
 *   • Bütün ilerleme mod-özel daily_quest_submit_* RPC'leriyle işlenir;
 *     tamamlanma YALNIZ sunucu "completed" dediğinde gerçekleşir. Client
 *     final skor/süre/hedef gönderemez.
 *   • Sayaç sunucu deadline'ına (server_now çıpası) bağlıdır; client saati
 *     yalnız görüntüyü biçimlendirir.
 *   • Bayrak/Çark içeriği sunucudan TEK TEK gelir (yalnız mevcut soru/hedef);
 *     tekrar denemede içerik sunucuda sabittir (reroll yok).
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import WorldMap, { RouteMapView } from "./WorldMap";
import { buildKeyToTopoId } from "./RouteGame";
import GoldIcon from "./GoldIcon";
import { playSound } from "../lib/sound";
import {
  claimDailyQuestReward,
  dailyQuestRemainingSeconds,
  refreshDailyQuestStatus,
  startDailyQuestAttempt,
  submitDailyQuestCountry,
  submitDailyQuestFlagAnswer,
  submitDailyQuestRouteMove,
  submitDailyQuestWheelPick,
  buildDailyQuestSession,
  DAILY_QUEST_MODE_META,
  DAILY_QUEST_REGION_LABELS,
  type DailyQuestRegion,
  type DailyQuestSession,
} from "../lib/dailyQuest";
import {
  CODE_TO_ENTRY,
  getContinentIds,
  getWheelPool,
  normalizeInput,
  NORM_TO_ROUTE_KEY,
  resolveCountryAnswer,
  routeKeyToDisplay,
  TOPOID_TO_ENTRY,
  type Continent,
} from "../data/countries";

type Outcome = "completed" | "failed" | null;

interface DailyQuestGameProps {
  session: DailyQuestSession;
  /** Ana menüye dönüş — App görev modalını yeniden açar. */
  onExit: () => void;
}

/* ── Ortak küçük HUD ────────────────────────────────────────────────────── */

function QuestHud({
  goal,
  progress,
  remaining,
  totalSeconds,
}: {
  goal: string;
  progress: string;
  remaining: number;
  totalSeconds: number;
}) {
  const ratio = totalSeconds > 0 ? remaining / totalSeconds : 0;
  const timerClass =
    ratio > 0.33 ? "" : ratio > 0.13 ? " dq-hud-timer--warn" : " dq-hud-timer--low";
  return (
    <div className="dq-hud" role="status" aria-label="Günün Görevi durumu">
      <span className="dq-hud-badge">
        <img src="/assets/icons/home/daily-quest-scroll.png" alt="" aria-hidden="true" />
        Günün Görevi
      </span>
      <span className="dq-hud-goal">{goal}</span>
      <span className="dq-hud-progress">{progress}</span>
      <span className={"dq-hud-timer" + timerClass}>
        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   KÖK — oturum + sonuç katmanı
════════════════════════════════════════════════════════════════════════ */

export default function DailyQuestGame({ session: initial, onExit }: DailyQuestGameProps) {
  const [session, setSession] = useState<DailyQuestSession>(initial);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [claimState, setClaimState] = useState<"idle" | "busy" | "claimed" | "error">("idle");
  const [claimedGold, setClaimedGold] = useState<number | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [remaining, setRemaining] = useState(() => dailyQuestRemainingSeconds(initial));

  const totalSeconds = useMemo(() => {
    const c = session.config as Record<string, number>;
    switch (session.mode) {
      case "country_write":  return Number(c.duration_seconds ?? 0);
      case "flag_quiz":      return Number(c.window_seconds ?? 0);
      case "route_complete": return Number(c.deadline_seconds ?? 0);
      case "wheel_find":     return Number(c.total_seconds ?? 0);
    }
  }, [session]);

  // Sunucu deadline'ı görev süresine küçük bir network grace'i ekler (+5/+10sn,
  // uçuştaki son cevap kaybolmasın diye). UI sayacı GÖREV süresini gösterir:
  // grace görüntüden düşülür; görünen süre 0 olunca oturum client tarafında
  // "başarısız" görünümüne geçer (otorite yine sunucu deadline'ı).
  const graceSeconds = useMemo(() => {
    const startedMs = Date.parse(session.view.started_at);
    if (!Number.isFinite(startedMs)) return 0;
    const windowSec = Math.round((session.deadlineMs - startedMs) / 1000);
    return Math.max(0, windowSec - totalSeconds);
  }, [session, totalSeconds]);

  useEffect(() => {
    if (outcome) return;
    const t = window.setInterval(() => {
      const r = Math.max(0, dailyQuestRemainingSeconds(session) - graceSeconds);
      setRemaining(r);
      if (r <= 0) {
        playSound("lose");
        setOutcome("failed");
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [session, outcome, graceSeconds]);

  const handleCompleted = useCallback(() => {
    playSound("win");
    setOutcome("completed");
    void refreshDailyQuestStatus();
  }, []);

  const handleFailed = useCallback(() => {
    playSound("lose");
    setOutcome("failed");
    void refreshDailyQuestStatus();
  }, []);

  const handleClaim = async () => {
    if (claimState === "busy" || claimState === "claimed") return;
    playSound("click");
    setClaimState("busy");
    const res = await claimDailyQuestReward(session.attemptId);
    if (res.ok) {
      playSound("correct");
      setClaimedGold(res.amount ?? session.rewardGold);
      setClaimState("claimed");
    } else if (res.code === "already_claimed") {
      setClaimState("claimed");
    } else {
      setClaimState("error");
    }
  };

  const handleRetry = async () => {
    if (retryBusy) return;
    playSound("click");
    setRetryBusy(true);
    const res = await startDailyQuestAttempt(false);
    setRetryBusy(false);
    if (!res.ok || !res.attempt) {
      // Görev bitmiş / tamamlanmış olabilir → menüye dön, modal durumu gösterir.
      onExit();
      return;
    }
    const next = buildDailyQuestSession(
      {
        title: session.questTitle,
        reward_gold: session.rewardGold,
        mode: session.mode,
        config: res.config ?? session.config,
      },
      res.attempt,
      res.server_now
    );
    setSession(next);
    setRemaining(dailyQuestRemainingSeconds(next));
    setOutcome(null);
    setClaimState("idle");
  };

  const meta = DAILY_QUEST_MODE_META[session.mode];

  return (
    <div className="dq-game-root">
      <header className="dq-game-header">
        <button
          type="button"
          className="dq-back"
          onClick={() => { playSound("click"); onExit(); }}
        >
          ← Menü
        </button>
        <div className="dq-game-title">
          <img src={meta.iconPath} alt="" aria-hidden="true" />
          <span>{meta.label}</span>
        </div>
        <span className="dq-game-reward" title="Görev ödülü">
          <GoldIcon /> +{session.rewardGold}
        </span>
      </header>

      {/* key=attemptId → Tekrar Dene'de mod görünümü temiz state ile kurulur;
          İÇERİK yine sunucuda sabittir (reroll edilemez). */}
      {session.mode === "country_write" && (
        <CountryWriteView key={session.attemptId} session={session}
          remaining={remaining} totalSeconds={totalSeconds}
          disabled={outcome !== null}
          onCompleted={handleCompleted} />
      )}
      {session.mode === "flag_quiz" && (
        <FlagQuizView key={session.attemptId} session={session}
          remaining={remaining} totalSeconds={totalSeconds}
          disabled={outcome !== null}
          onCompleted={handleCompleted} onFailed={handleFailed} />
      )}
      {session.mode === "route_complete" && (
        <RouteQuestView key={session.attemptId} session={session}
          remaining={remaining} totalSeconds={totalSeconds}
          disabled={outcome !== null}
          onCompleted={handleCompleted} />
      )}
      {session.mode === "wheel_find" && (
        <WheelQuestView key={session.attemptId} session={session}
          remaining={remaining} totalSeconds={totalSeconds}
          disabled={outcome !== null}
          onCompleted={handleCompleted} />
      )}

      {outcome && (
        <div className="dq-result-backdrop">
          <div className="dq-result-panel" role="dialog" aria-modal="true">
            <div className="dq-result-emoji" aria-hidden="true">
              {outcome === "completed" ? "🏆" : "⏰"}
            </div>
            <h2 className="dq-result-title">
              {outcome === "completed" ? "Görev Tamamlandı!" : "Bu Sefer Olmadı"}
            </h2>
            <p className="dq-result-sub">
              {outcome === "completed"
                ? "Günün Görevi'ni başarıyla bitirdin."
                : "Gün bitmeden istediğin kadar tekrar deneyebilirsin."}
            </p>
            <div className="dq-result-actions">
              {outcome === "completed" && claimState !== "claimed" && (
                <button type="button" className="dq-btn dq-btn--cta dq-btn--claim"
                  disabled={claimState === "busy"}
                  onClick={() => void handleClaim()}>
                  <GoldIcon />
                  {claimState === "busy" ? "Alınıyor…" : `Ödülü Al (+${session.rewardGold})`}
                </button>
              )}
              {outcome === "completed" && claimState === "claimed" && (
                <span className="dq-result-claimed">
                  ✓ {claimedGold != null ? `+${claimedGold} Gold alındı` : "Ödül alındı"}
                </span>
              )}
              {claimState === "error" && (
                <p className="dq-error">Ödül alınamadı — menüden tekrar deneyebilirsin.</p>
              )}
              {outcome === "failed" && (
                <button type="button" className="dq-btn dq-btn--cta"
                  disabled={retryBusy}
                  onClick={() => void handleRetry()}>
                  {retryBusy ? "Başlatılıyor…" : "Tekrar Dene"}
                </button>
              )}
              <button type="button" className="dq-btn dq-btn--ghost"
                onClick={() => { playSound("click"); onExit(); }}>
                ⌂ Ana Menü
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   A) ÜLKE YAZ — sunucu tek tek cevap sayar
════════════════════════════════════════════════════════════════════════ */

function CountryWriteView({
  session, remaining, totalSeconds, disabled, onCompleted,
}: {
  session: DailyQuestSession;
  remaining: number;
  totalSeconds: number;
  disabled: boolean;
  onCompleted: () => void;
}) {
  const region = (session.config.region as DailyQuestRegion) ?? "world";
  const target = Number(session.config.target_count ?? 0);
  const activeIds = useMemo(() => getContinentIds(region as Continent | "world"), [region]);

  const [foundCodes, setFoundCodes] = useState<Set<string>>(
    () => new Set(session.view.found_codes ?? [])
  );
  const [serverCount, setServerCount] = useState(session.view.found_count ?? 0);
  const [lastGuessed, setLastGuessed] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<"" | "correct" | "dup" | "wrong" | "region">("");
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const flash = (f: typeof feedback) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(f);
    feedbackTimer.current = setTimeout(() => setFeedback(""), 800);
  };

  const guessedISOs = useMemo(() => {
    const s = new Set<string>();
    for (const code of foundCodes) {
      const topo = CODE_TO_ENTRY[code]?.topoId;
      if (topo) s.add(topo);
    }
    return s;
  }, [foundCodes]);

  const handleGuess = () => {
    if (disabled) return;
    const code = resolveCountryAnswer(input);
    setInput("");
    if (!code) { playSound("wrong"); flash("wrong"); return; }
    const entry = CODE_TO_ENTRY[code];
    if (!entry) { playSound("wrong"); flash("wrong"); return; }
    if (foundCodes.has(code)) { flash("dup"); return; }
    if (entry.topoId && !activeIds.has(entry.topoId)) {
      playSound("wrong"); flash("region"); return;
    }
    // Optimistic yerel işaretleme (hızlı yazım akışı için) + sunucu mutabakatı:
    // sunucu reddederse geri alınır; TAMAMLANMA yalnız sunucu onayıyla olur.
    setFoundCodes((prev) => new Set(prev).add(code));
    setLastGuessed(entry.topoId || null);
    playSound("correct");
    flash("correct");
    void submitDailyQuestCountry(session.attemptId, code).then((res) => {
      if (!res.ok) {
        if (res.code === "deadline_passed" || res.code === "attempt_not_active") return;
        setFoundCodes((prev) => { const n = new Set(prev); n.delete(code); return n; });
        return;
      }
      if (res.accepted) {
        setServerCount(res.found_count ?? 0);
        if (res.completed && !completedRef.current) {
          completedRef.current = true;
          onCompleted();
        }
      } else if (res.reason !== "duplicate") {
        // invalid_country / wrong_region: yerel işareti geri al.
        setFoundCodes((prev) => { const n = new Set(prev); n.delete(code); return n; });
      }
    });
  };

  const shown = Math.max(foundCodes.size, serverCount);

  return (
    <>
      <QuestHud
        goal={`${DAILY_QUEST_REGION_LABELS[region]} · ${target} ülke`}
        progress={`${Math.min(shown, target)} / ${target}`}
        remaining={remaining}
        totalSeconds={totalSeconds}
      />
      <div className="dq-input-row">
        <input
          ref={inputRef}
          type="text"
          className="dq-input"
          placeholder="Ülke adı yaz… (Enter)"
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleGuess(); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        />
        <button type="button" className="dq-btn dq-btn--cta dq-btn--inline"
          disabled={disabled} onClick={handleGuess}>Gir</button>
        <span className="dq-feedback" aria-live="polite">
          {feedback === "correct" && <span className="dq-fb-ok">✓ Doğru!</span>}
          {feedback === "dup" && <span className="dq-fb-dup">Zaten bulundu</span>}
          {feedback === "wrong" && <span className="dq-fb-no">✗ Bulunamadı</span>}
          {feedback === "region" && <span className="dq-fb-no">✗ Bu bölgede değil</span>}
        </span>
      </div>
      <div className="dq-map-area">
        <WorldMap
          guessedISOs={guessedISOs}
          lastGuessed={lastGuessed}
          showLabels={false}
          activeIds={activeIds}
          resetKey={0}
          region={region}
        />
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   B) BAYRAK BİLMECE — sıra sunucuda, soru başına TEK cevap
════════════════════════════════════════════════════════════════════════ */

function FlagQuizView({
  session, remaining, totalSeconds, disabled, onCompleted, onFailed,
}: {
  session: DailyQuestSession;
  remaining: number;
  totalSeconds: number;
  disabled: boolean;
  onCompleted: () => void;
  onFailed: () => void;
}) {
  const total = Number(session.config.total_questions ?? 0);
  const required = Number(session.config.required_correct ?? 0);

  const [currentCode, setCurrentCode] = useState<string | null>(session.view.current_code ?? null);
  const [index, setIndex] = useState(session.view.next_index ?? 0);
  const [correct, setCorrect] = useState(session.view.correct_count ?? 0);
  const [wrong, setWrong] = useState(session.view.wrong_count ?? 0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ ok: boolean; display: string } | null>(null);
  const [unknownInput, setUnknownInput] = useState(false);
  const [imgError, setImgError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const submit = async (code: string | null) => {
    if (busy || disabled || currentCode == null) return;
    setBusy(true);
    setUnknownInput(false);
    const res = await submitDailyQuestFlagAnswer(session.attemptId, index, code);
    if (!res.ok) { setBusy(false); return; }
    playSound(res.correct ? "correct" : "wrong");
    setReveal({
      ok: !!res.correct,
      display: CODE_TO_ENTRY[res.answer_code ?? ""]?.display ?? res.answer_code ?? "",
    });
    setCorrect(res.correct_count ?? 0);
    setWrong(res.wrong_count ?? 0);
    // Kısa cevap gösterimi → sonra sıradaki bayrak (sunucudan gelen).
    window.setTimeout(() => {
      setReveal(null);
      setIndex(res.next_index ?? index + 1);
      setCurrentCode(res.next_code ?? null);
      setImgError(false);
      setBusy(false);
      if (res.completed) onCompleted();
      else if (res.failed) onFailed();
      else inputRef.current?.focus();
    }, 1200);
  };

  const handleGuess = () => {
    if (busy || disabled) return;
    const code = resolveCountryAnswer(input);
    setInput("");
    if (!code) {
      // Çözülemeyen metin soruyu HARCAMAZ (yazım hatası cezası yok).
      playSound("wrong");
      setUnknownInput(true);
      window.setTimeout(() => setUnknownInput(false), 900);
      return;
    }
    void submit(code);
  };

  const flagSrc = currentCode ? `/assets/flags/${currentCode}.svg` : "";

  return (
    <>
      <QuestHud
        goal={`${required}/${total} doğru`}
        progress={`✓ ${correct} · ✗ ${wrong} · Soru ${Math.min(index + 1, total)}/${total}`}
        remaining={remaining}
        totalSeconds={totalSeconds}
      />
      <div className="dq-flag-stage">
        {currentCode && (
          <div className="dq-flag-wrap">
            {imgError ? (
              <div className="dq-flag-fallback">{currentCode.toUpperCase()}</div>
            ) : (
              <img key={currentCode} src={flagSrc} alt="Bayrak" className="dq-flag-img"
                onError={() => setImgError(true)} />
            )}
          </div>
        )}
        <div className="dq-flag-prompt" aria-live="polite">
          {reveal
            ? (reveal.ok
                ? <span className="dq-fb-ok">✓ Doğru! {reveal.display}</span>
                : <span className="dq-fb-no">✗ Cevap: {reveal.display}</span>)
            : unknownInput
            ? <span className="dq-fb-no">Bu ülke tanınmıyor — soru harcanmadı</span>
            : "Bu bayrağın ülkesi nedir?"}
        </div>
      </div>
      <div className="dq-input-row">
        <input
          ref={inputRef}
          type="text"
          className="dq-input"
          placeholder="Ülke adı yaz… (Enter)"
          value={input}
          disabled={busy || disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleGuess(); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        />
        <button type="button" className="dq-btn dq-btn--cta dq-btn--inline"
          disabled={busy || disabled} onClick={handleGuess}>Gir</button>
        <button type="button" className="dq-btn dq-btn--ghost dq-btn--inline"
          disabled={busy || disabled} onClick={() => { playSound("click"); void submit(null); }}>
          Pas Geç
        </button>
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   C) ROTA — komşuluk sunucu grafında doğrulanır
════════════════════════════════════════════════════════════════════════ */

function RouteQuestView({
  session, remaining, totalSeconds, disabled, onCompleted,
}: {
  session: DailyQuestSession;
  remaining: number;
  totalSeconds: number;
  disabled: boolean;
  onCompleted: () => void;
}) {
  const keyToTopoId = useMemo(buildKeyToTopoId, []);
  const startKey = session.view.start_key ?? "";
  const targetKey = session.view.target_key ?? "";

  const [path, setPath] = useState<string[]>(session.view.path ?? [startKey]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentKey = path[path.length - 1] ?? startKey;

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const showErr = (msg: string) => {
    if (errTimer.current) clearTimeout(errTimer.current);
    setErrMsg(msg);
    errTimer.current = setTimeout(() => setErrMsg(null), 2200);
  };

  const handleGuess = async () => {
    if (busy || disabled) return;
    const norm = normalizeInput(input);
    if (!norm) return;
    const key = NORM_TO_ROUTE_KEY[norm];
    setInput("");
    if (!key) { playSound("wrong"); showErr("Bu ülke tanınmıyor."); return; }
    if (key === currentKey) { playSound("wrong"); showErr("Zaten bu ülkedesin."); return; }

    setBusy(true);
    const res = await submitDailyQuestRouteMove(session.attemptId, key);
    setBusy(false);
    if (!res.ok) return;
    if (!res.accepted) {
      playSound("wrong");
      showErr(
        res.reason === "not_neighbor"
          ? `"${routeKeyToDisplay(key)}" — ${routeKeyToDisplay(res.current_key ?? currentKey)} ile komşu değil.`
          : "Geçersiz hamle."
      );
      return;
    }
    playSound("correct");
    setPath(res.path ?? [...path, key]);
    if (res.completed) onCompleted();
    else inputRef.current?.focus();
  };

  return (
    <>
      <QuestHud
        goal={`${routeKeyToDisplay(startKey)} → ${routeKeyToDisplay(targetKey)}`}
        progress={`${path.length - 1} adım`}
        remaining={remaining}
        totalSeconds={totalSeconds}
      />
      <div className="dq-map-area">
        <RouteMapView
          routeKeys={path}
          startKey={startKey}
          targetKey={targetKey}
          keyToTopoId={keyToTopoId}
        />
      </div>
      <div className="dq-route-path">
        <div className="route-path-chips">
          {path.map((key, i) => (
            <span key={`${key}-${i}`} className="route-step-wrap">
              <span className={
                "route-step " + (
                  i === 0 ? "route-step-start" :
                  key === targetKey ? "route-step-win" :
                  i === path.length - 1 ? "route-step-current" :
                  "route-step-visited"
                )
              }>
                {routeKeyToDisplay(key)}
              </span>
              {i < path.length - 1 && <span className="route-chevron">›</span>}
            </span>
          ))}
          {currentKey !== targetKey && (
            <span className="route-step-wrap">
              <span className="route-chevron">›</span>
              <span className="route-step route-step-ghost">{routeKeyToDisplay(targetKey)}?</span>
            </span>
          )}
        </div>
      </div>
      <div className="dq-input-row">
        <input
          ref={inputRef}
          type="text"
          className="dq-input"
          placeholder={`${routeKeyToDisplay(currentKey)} ile komşu ülke yaz… (Enter)`}
          value={input}
          disabled={busy || disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleGuess(); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
        />
        <button type="button" className="dq-btn dq-btn--cta dq-btn--inline"
          disabled={busy || disabled} onClick={() => void handleGuess()}>Gir</button>
        <span className="dq-feedback" aria-live="polite">
          {errMsg && <span className="dq-fb-no">⚠ {errMsg}</span>}
        </span>
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   D) ÇARK — hedef dizisi sunucuda, tek tek açıklanır
════════════════════════════════════════════════════════════════════════ */

function WheelQuestView({
  session, remaining, totalSeconds, disabled, onCompleted,
}: {
  session: DailyQuestSession;
  remaining: number;
  totalSeconds: number;
  disabled: boolean;
  onCompleted: () => void;
}) {
  const region = (session.config.region as DailyQuestRegion) ?? "world";
  const targetCount = Number(session.config.target_count ?? 0);
  const activeIds = useMemo(() => getContinentIds(region as Continent | "world"), [region]);
  // Spin animasyonunun yalnız GÖRSEL isim havuzu (hedefler sunucudan gelir).
  const spinPool = useMemo(
    () => getWheelPool(region as Continent | "world", "all").map((c) => c.display),
    [region]
  );

  const [targetCode, setTargetCode] = useState<string | null>(session.view.current_code ?? null);
  const [foundIdx, setFoundIdx] = useState(session.view.target_index ?? 0);
  const [guessedISOs, setGuessedISOs] = useState<Set<string>>(new Set());
  const [lastGuessed, setLastGuessed] = useState<string | null>(null);
  const [wrongId, setWrongId] = useState("");
  const [spinning, setSpinning] = useState(true);
  const [spinDisplay, setSpinDisplay] = useState("");
  const busyRef = useRef(false);
  const wrongTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinTimers = useRef<{ int: ReturnType<typeof setInterval> | null; out: ReturnType<typeof setTimeout> | null }>({ int: null, out: null });

  // Yeni hedef geldiğinde kısa çark animasyonu (yalnız görsel; hedef sabit).
  useEffect(() => {
    if (!targetCode) { setSpinning(false); return; }
    setSpinning(true);
    spinTimers.current.int = setInterval(() => {
      setSpinDisplay(spinPool[Math.floor(Math.random() * spinPool.length)] ?? "");
    }, 70);
    spinTimers.current.out = setTimeout(() => {
      if (spinTimers.current.int) clearInterval(spinTimers.current.int);
      spinTimers.current.int = null;
      setSpinning(false);
    }, 700);
    return () => {
      if (spinTimers.current.int) clearInterval(spinTimers.current.int);
      if (spinTimers.current.out) clearTimeout(spinTimers.current.out);
      spinTimers.current.int = null;
      spinTimers.current.out = null;
    };
  }, [targetCode, spinPool]);

  const targetDisplay = targetCode ? CODE_TO_ENTRY[targetCode]?.display ?? "" : "";

  const handleCountryClick = useCallback((topoId: string) => {
    if (disabled || spinning || busyRef.current || !targetCode) return;
    const entry = TOPOID_TO_ENTRY[topoId];
    if (!entry || guessedISOs.has(topoId)) return;
    busyRef.current = true;
    void submitDailyQuestWheelPick(session.attemptId, entry.code).then((res) => {
      busyRef.current = false;
      if (!res.ok) return;
      if (!res.correct) {
        playSound("wrong");
        setWrongId(topoId);
        if (wrongTimer.current) clearTimeout(wrongTimer.current);
        wrongTimer.current = setTimeout(() => setWrongId(""), 600);
        return;
      }
      playSound("correct");
      const foundTopo = CODE_TO_ENTRY[res.found_code ?? ""]?.topoId;
      if (foundTopo) {
        setGuessedISOs((prev) => new Set(prev).add(foundTopo));
        setLastGuessed(foundTopo);
      }
      setFoundIdx(res.target_index ?? foundIdx + 1);
      if (res.completed) {
        setTargetCode(null);
        onCompleted();
      } else {
        setTargetCode(res.next_code ?? null);
      }
    });
  }, [disabled, spinning, targetCode, guessedISOs, session.attemptId, foundIdx, onCompleted]);

  return (
    <>
      <QuestHud
        goal={`${DAILY_QUEST_REGION_LABELS[region]} · ${targetCount} hedef`}
        progress={`${foundIdx} / ${targetCount}`}
        remaining={remaining}
        totalSeconds={totalSeconds}
      />
      <div className="dq-wheel-target" aria-live="polite">
        {spinning ? (
          <><span className="dq-wheel-label">🎡 Çark dönüyor…</span>
            <strong className="dq-wheel-name dq-wheel-name--cycle">{spinDisplay || "—"}</strong></>
        ) : targetCode ? (
          <><span className="dq-wheel-label">🎯 Hedef:</span>
            <strong className="dq-wheel-name">{targetDisplay}</strong>
            <span className="dq-wheel-hint">Haritada bul ve tıkla</span></>
        ) : null}
      </div>
      <div className="dq-map-area">
        <WorldMap
          guessedISOs={guessedISOs}
          lastGuessed={lastGuessed}
          showLabels={false}
          activeIds={activeIds}
          resetKey={0}
          region={region}
          onCountryClick={handleCountryClick}
          wrongId={wrongId || undefined}
        />
      </div>
    </>
  );
}
