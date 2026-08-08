/**
 * DailyQuestModal.tsx — Günün Görevi modalı (desktop) + mobil alt-sheet.
 *
 * Tek bileşen, tek sunucu durumu: desktop'ta merkezde zümrüt panel, ≤600px'te
 * CSS ile alt-sheet düzenine döner (aynı .dq-modal ağacı — ayrı mobil mantık
 * YOK). Bütün veriler daily_quest_get_state RPC'sinden gelir; görev ayarları
 * kilitlidir, client hiçbir hedef/süre/ödül parametresi göndermez.
 *
 * Görsel dil: Zümrüt Vadi --zv-* tokenları (.dq-overlay köküne bağlanır,
 * aktif ana ekran temasından bağımsız olarak zümrüt aile). Gold için mevcut
 * GoldIcon kullanılır; yeni asset yok.
 */
import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { playSound } from "../lib/sound";
import GoldIcon from "./GoldIcon";
import {
  claimDailyQuestReward,
  buildDailyQuestSession,
  describeLockedSettings,
  fetchDailyQuestState,
  formatQuestCountdown,
  startDailyQuestAttempt,
  DAILY_QUEST_MODE_META,
  type DailyQuestSession,
  type DailyQuestState,
} from "../lib/dailyQuest";

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const sel = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null && el.getAttribute("tabindex") !== "-1"
  );
}

type CtaKind = "start" | "resume" | "retry" | "claim" | "claimed" | "expired";

export function DailyQuestModal({
  onClose,
  onStartSession,
  introMode = false,
}: {
  onClose: () => void;
  /** "Göreve Başla / Devam Et / Tekrar Dene" → App görev oyun ekranını açar. */
  onStartSession: (session: DailyQuestSession) => void;
  /** İlk-giriş intro'su olarak OTOMATİK açıldıysa true: birincil CTA'nın yanına
   *  açık bir "Şimdi Değil" ikincil butonu eklenir (kapatma davranışı = onClose;
   *  görevi tamamlamaz, ödül vermez). Manuel açılışta (buton/sekme) false →
   *  görünüm birebir aynı kalır. */
  introMode?: boolean;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DailyQuestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [claimedNow, setClaimedNow] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // server_now çıpası: kalan süre client saatiyle DEĞİL bu offset'le akar.
  const serverOffsetRef = useRef(0);
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const s = await fetchDailyQuestState();
    if (s.ok && s.server_now) {
      serverOffsetRef.current = Date.parse(s.server_now) - Date.now();
    }
    if (!s.ok) {
      setErrorMsg(
        s.code === "daily_quest_pool_exhausted"
          ? "Bugünün görevi hazırlanamadı. Lütfen daha sonra tekrar dene."
          : s.code === "db_not_ready"
          ? "Günün Görevi henüz bu sunucuda aktif değil."
          : s.code === "unauthenticated" || s.code === "no_profile"
          ? "Günün Görevi için giriş yapmalısın."
          : "Görev bilgisi alınamadı. Bağlantını kontrol edip tekrar dene."
      );
    }
    setState(s);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Kalan süre için saniye tik'i (yalnız görüntü).
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Odak + Escape + backdrop + arka plan scroll kilidi (mobil sheet dili).
  useEffect(() => {
    const t = window.setTimeout(() => modalRef.current?.focus(), 30);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const onModalKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = getFocusable(modalRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey && (activeEl === first || activeEl === modalRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault(); first.focus();
    }
  }, []);

  const quest = state?.ok ? state.quest ?? null : null;
  const attempt = state?.ok ? state.attempt ?? null : null;
  const claimed = claimedNow || (state?.ok ? !!state.claimed : false);
  const questEnded =
    quest != null &&
    Date.parse(quest.ends_at) - (Date.now() + serverOffsetRef.current) <= 0;

  const cta: CtaKind = !quest
    ? "start"
    : claimed
    ? "claimed"
    : questEnded
    ? "expired"
    : state?.has_completed
    ? "claim"
    : attempt && attempt.status === "active"
    ? "resume"
    : state?.has_failed_attempt
    ? "retry"
    : "start";

  const handleStart = async (resume: boolean) => {
    if (busy || !quest) return;
    playSound("click");
    setBusy(true);
    const res = await startDailyQuestAttempt(resume);
    setBusy(false);
    if (!res.ok || !res.attempt) {
      if (res.code === "already_completed" || res.code === "quest_ended") {
        void load(); // durum değişmiş → tazele (Ödülü Al / Süresi Doldu görünür)
        return;
      }
      setErrorMsg("Görev başlatılamadı. Lütfen tekrar dene.");
      return;
    }
    onStartSession(
      buildDailyQuestSession(
        { title: quest.title, reward_gold: quest.reward_gold, mode: quest.mode, config: quest.config },
        res.attempt,
        res.server_now
      )
    );
  };

  const handleClaim = async () => {
    if (busy || !state?.completed_attempt_id) return;
    playSound("click");
    setBusy(true);
    const res = await claimDailyQuestReward(state.completed_attempt_id);
    setBusy(false);
    if (res.ok || res.code === "already_claimed") {
      playSound("correct");
      setClaimedNow(true);
    } else if (res.code === "quest_ended") {
      void load();
    } else {
      setErrorMsg("Ödül alınamadı. Lütfen tekrar dene.");
    }
  };

  const meta = quest ? DAILY_QUEST_MODE_META[quest.mode] : null;
  const settings = quest ? describeLockedSettings(quest.mode, quest.config) : [];

  /* Aktif attempt için kısa ilerleme satırı. */
  const progressLine = (() => {
    if (!quest || !attempt || attempt.status !== "active") return null;
    switch (quest.mode) {
      case "country_write":
        return `İlerleme: ${attempt.found_count ?? 0} / ${attempt.target ?? "?"} ülke`;
      case "flag_quiz":
        return `İlerleme: ${attempt.correct_count ?? 0} / ${attempt.required ?? "?"} doğru · soru ${(attempt.next_index ?? 0) + 1}/${attempt.total ?? "?"}`;
      case "wheel_find":
        return `İlerleme: ${attempt.target_index ?? 0} / ${attempt.target_count ?? "?"} hedef`;
      case "route_complete":
        return `İlerleme: ${(attempt.path?.length ?? 1) - 1} adım`;
    }
  })();

  return (
    <div
      className="overlay dq-overlay"
      onClick={() => { playSound("click"); onClose(); }}
    >
      <div
        ref={modalRef}
        className="dq-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dq-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
      >
        <div className="dq-grab" aria-hidden="true" />
        <header className="dq-head">
          <img
            className="dq-head-icon"
            src="/assets/icons/home/daily-quest-scroll.png"
            alt=""
            aria-hidden="true"
          />
          <div className="dq-head-text">
            <h2 id="dq-title" className="dq-title">Günün Görevi</h2>
            {quest && (
              <p className="dq-countdown" aria-live="polite">
                Kalan süre: {formatQuestCountdown(quest.ends_at, serverOffsetRef.current)}
              </p>
            )}
          </div>
          <button
            type="button"
            className="dq-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>

        {loading && (
          <div className="dq-body dq-body--center">
            <span className="dq-spinner" aria-hidden="true" />
            <p className="dq-muted">Bugünün görevi yükleniyor…</p>
          </div>
        )}

        {!loading && errorMsg && (
          <div className="dq-body dq-body--center">
            <p className="dq-error">{errorMsg}</p>
            <button type="button" className="dq-btn dq-btn--ghost" onClick={() => void load()}>
              Tekrar Dene
            </button>
          </div>
        )}

        {!loading && !errorMsg && quest && meta && (
          <div className="dq-body">
            <div className="dq-quest-card">
              <div className="dq-quest-mode">
                <img className="dq-mode-icon" src={meta.iconPath} alt="" aria-hidden="true" />
                <span className="dq-mode-label">{meta.label}</span>
                <span className="dq-reward" title="Görev ödülü">
                  <GoldIcon />
                  <span>+{quest.reward_gold}</span>
                </span>
              </div>
              <p className="dq-desc">{quest.description}</p>
              <div className="dq-settings" aria-label="Kilitli görev ayarları">
                {settings.map((s) => (
                  <span key={s.label} className="dq-chip">
                    <span className="dq-chip-label">{s.label}</span>
                    <span className="dq-chip-value">{s.value}</span>
                  </span>
                ))}
              </div>
              {progressLine && <p className="dq-progress">{progressLine}</p>}
              {cta === "claim" && (
                <p className="dq-progress dq-progress--done">Görev tamamlandı — ödülün hazır!</p>
              )}
              {claimed && (
                <p className="dq-progress dq-progress--done">Bugünkü ödül alındı. Yarın yeni görev seni bekliyor.</p>
              )}
            </div>

            <div className="dq-actions">
              {cta === "start" && (
                <button type="button" className="dq-btn dq-btn--cta" disabled={busy}
                  onClick={() => void handleStart(false)}>
                  {busy ? "Başlatılıyor…" : "Göreve Başla"}
                </button>
              )}
              {cta === "resume" && (
                <>
                  <button type="button" className="dq-btn dq-btn--cta" disabled={busy}
                    onClick={() => void handleStart(true)}>
                    {busy ? "Yükleniyor…" : "Devam Et"}
                  </button>
                  <button type="button" className="dq-btn dq-btn--ghost" disabled={busy}
                    onClick={() => void handleStart(false)}>
                    Baştan Başla
                  </button>
                </>
              )}
              {cta === "retry" && (
                <button type="button" className="dq-btn dq-btn--cta" disabled={busy}
                  onClick={() => void handleStart(false)}>
                  {busy ? "Başlatılıyor…" : "Tekrar Dene"}
                </button>
              )}
              {cta === "claim" && (
                <button type="button" className="dq-btn dq-btn--cta dq-btn--claim" disabled={busy}
                  onClick={() => void handleClaim()}>
                  <GoldIcon />
                  {busy ? "Alınıyor…" : `Ödülü Al (+${quest.reward_gold})`}
                </button>
              )}
              {cta === "claimed" && (
                <button type="button" className="dq-btn dq-btn--done" disabled>
                  ✓ Ödül Alındı
                </button>
              )}
              {cta === "expired" && (
                <button type="button" className="dq-btn dq-btn--ghost" onClick={() => void load()}>
                  Süresi Doldu — Yenile
                </button>
              )}
              {/* İlk-giriş intro'su: birincil CTA'nın altında açık "Şimdi Değil".
                  Kapatma davranışı onClose ile aynı (görevi tamamlamaz, ödül
                  vermez, hatırlatıcı + badge devam eder). Terminal durumlarda
                  (alındı / süresi doldu) gösterilmez — kapatma düğmesi yeterli. */}
              {introMode && cta !== "claimed" && cta !== "expired" && (
                <button
                  type="button"
                  className="dq-btn dq-btn--ghost"
                  disabled={busy}
                  onClick={() => { playSound("click"); onClose(); }}
                >
                  Şimdi Değil
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
