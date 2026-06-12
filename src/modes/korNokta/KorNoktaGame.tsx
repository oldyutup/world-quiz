/**
 * KorNoktaGame — Kör Nokta gameplay V1 (tur döngüsü ekranları).
 *
 * KorNoktaMode lobby'sinin altında, room.status 'playing'/'finished' iken
 * render edilir. Oyun durumu tevatur_rooms.game_state jsonb blob'undan okunur
 * ve mevcut realtime UPDATE aboneliğiyle akar — bu bileşen kendi kanalını
 * AÇMAZ, room prop'u değiştikçe yeniden render olur.
 *
 * Yetki modeli:
 *   • Faz ilerletme host-authoritative: host client phaseEndsAt'i (server
 *     epoch ms, serverClock offset'iyle karşılaştırılır) geçince
 *     tevatur_kn_advance_phase çağırır. Server expected-state guard ile
 *     bayat/yinelenen çağrıları no-op'lar.
 *   • Rapor ve tahmin yazmaları yalnız ilgili oyuncunun RPC'siyle olur;
 *     server rol + faz + içerik validasyonunu tekrarlar.
 *
 * Gizlilik (MVP, spec §10): blob herkese gider; dedektife fotoğraf ve yazar
 * adları YALNIZ UI'da gösterilmez (dedektif dalları Panorama360'ı hiç mount
 * etmez, rapor kartları reveal'e kadar isimsizdir).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { supabase, type TevaturRoom, type TevaturPlayer } from "../../lib/supabase";
import { getSyncedNowMs, initServerClockSync } from "../../lib/serverClock";
import { playSound, stopSound, getCountdownSoundMode } from "../../lib/sound";
import {
  KN_CATEGORY_HINTS,
  KN_CATEGORY_LABELS,
  KN_GOOD_GUESS_THRESHOLD,
  findKnScene,
  getKnRole,
  knReportLetter,
  parseKnGameState,
  type KnGameState,
  type KnPhase,
  type KnRound,
} from "./korNoktaGameTypes";
import { validateReport } from "./reportValidation";
import { resolveKnBackground } from "./korNoktaBackgrounds";
import Panorama360 from "./Panorama360";
import KorNoktaGuessMap, { type KnLatLng } from "./KorNoktaGuessMap";
import LobbyChat from "../../components/LobbyChat";
import "./KorNoktaGame.css";

/* ── RPC hata etiketleri → kullanıcı dostu Türkçe ── */
function describeKnGameError(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("report_banned"))
    return "Raporun konumu fazla doğrudan ele veriyor. Daha genel tarif et.";
  if (msg.includes("report_word_count")) return "Rapor 2–5 kelime arasında olmalı.";
  if (msg.includes("report_too_long"))   return "Rapor çok uzun. Daha kısa tarif et.";
  if (msg.includes("already_submitted")) return "Bu tur için zaten gönderdin.";
  if (msg.includes("wrong_phase"))       return "Bu aşama kapandı.";
  if (msg.includes("not_reporter"))      return "Bu turda raporcu değilsin.";
  if (msg.includes("not_detective"))     return "Bu turda dedektif değilsin.";
  if (msg.includes("guess_required"))    return "Önce haritaya pin koymalısın.";
  if (msg.includes("suspect_invalid") || msg.includes("useful_invalid"))
    return "Seçimlerinde bir sorun var. Tekrar dene.";
  if (msg.includes("game_not_active"))   return "Oyun aktif değil.";
  if (msg.includes("unauthorized"))
    return "Yetki hatası. Sayfayı yenileyip tekrar dene.";
  return null;
}

const PHASE_LABELS: Record<KnPhase, string> = {
  role_reveal:      "Roller",
  observe_report:   "İnceleme",
  detective_guess:  "Tahmin",
  guess_reveal:     "Tahmin Sonucu",
  report_judgement: "Değerlendirme",
  round_reveal:     "Dosya Açıldı",
  final_results:    "Sonuçlar",
};

/* ── Tur sonucunu sinematik karta indirger (yalnız sunum; mevcut
   round.result/moleId/judgement verisini okur, hiçbir skoru hesaplamaz). ── */
type KnOutcomeTone = "gold" | "danger" | "honest" | "neutral";
interface KnOutcome {
  title: string;
  sub: string;
  tone: KnOutcomeTone;
}
function resolveRoundOutcome(round: KnRound): KnOutcome {
  const hasMole = round.moleId != null;
  const caught = round.result?.caught ?? false;
  const mapScore = round.result?.mapScore ?? 0;
  const goodGuess = mapScore >= KN_GOOD_GUESS_THRESHOLD;
  if (hasMole) {
    return caught
      ? { title: "KÖSTEBEK YAKALANDI", sub: "Şüpheli doğru tespit edildi.", tone: "gold" }
      : { title: "KÖSTEBEK SIYRILDI", sub: "Dedektif yanlış yönlendirildi.", tone: "danger" };
  }
  // Köstebek yoktu. Dedektif iyi tahmin yaptıysa dürüstlerin zaferi vurgulanır.
  if (goodGuess && round.judgement?.suspect === "none") {
    return { title: "DÜRÜSTLER KAZANDI", sub: "Dedektif raporlarla konumu buldu.", tone: "honest" };
  }
  return round.judgement?.suspect === "none"
    ? { title: "KÖSTEBEK YOKTU", sub: "Dedektif doğru karar verdi.", tone: "neutral" }
    : { title: "KÖSTEBEK YOKTU", sub: "Bu turda köstebek yoktu.", tone: "neutral" };
}

function formatDistanceKm(distanceKm: number | null | undefined): string {
  if (distanceKm == null) return "—";
  return distanceKm >= 10
    ? `${Math.round(distanceKm).toLocaleString("tr-TR")} km`
    : `${distanceKm.toLocaleString("tr-TR")} km`;
}

interface KorNoktaGameProps {
  room: TevaturRoom;
  players: TevaturPlayer[];
  myId: string;
  claimToken: string;
  isHost: boolean;
  /** RPC cevaplarını ve watchdog refetch'lerini parent'ın room state'ine
   *  uygular (realtime echo'sunu beklemeden; out-of-order koruması parent'ta). */
  onRoomUpdate?: (room: TevaturRoom) => void;
  onExit: () => void;
}

export default function KorNoktaGame({
  room,
  players,
  myId,
  claimToken,
  isHost,
  onRoomUpdate,
  onExit,
}: KorNoktaGameProps) {
  const state: KnGameState | null = parseKnGameState(room.game_state);

  /* ── Server clock: phaseEndsAt karşılaştırmaları offset'li yapılır ── */
  useEffect(() => {
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, []);

  /* ── Geri sayım ticker'ı ── */
  const [nowMs, setNowMs] = useState(() => getSyncedNowMs());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(getSyncedNowMs()), 500);
    return () => window.clearInterval(id);
  }, []);

  const onRoomUpdateRef = useRef(onRoomUpdate);
  useEffect(() => {
    onRoomUpdateRef.current = onRoomUpdate;
  }, [onRoomUpdate]);

  /* ── Host faz timer'ı ── */
  const advanceInFlightRef = useRef(false);
  const advancePhase = useCallback(
    async (expectedRound: number, expectedPhase: KnPhase) => {
      if (advanceInFlightRef.current) return;
      advanceInFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("tevatur_kn_advance_phase", {
          p_room_id:        room.id,
          p_host_player_id: myId,
          p_claim_token:    claimToken,
          p_expected_round: expectedRound,
          p_expected_phase: expectedPhase,
        });
        if (error) {
          console.error("[KorNokta] advance_phase RPC failed", error);
        } else if (data?.id) {
          onRoomUpdateRef.current?.(data as TevaturRoom);
        }
      } finally {
        advanceInFlightRef.current = false;
      }
    },
    [room.id, myId, claimToken],
  );

  const phase = state?.phase ?? null;
  const roundIndex = state?.roundIndex ?? 0;
  const phaseEndsAt = state?.phaseEndsAt ?? null;

  useEffect(() => {
    if (!isHost || !phase || phase === "final_results" || phaseEndsAt == null) return;
    const id = window.setInterval(() => {
      // 600 ms grace: realtime echo gecikmesi / saat oynaması için tampon.
      if (getSyncedNowMs() >= phaseEndsAt + 600) {
        void advancePhase(roundIndex, phase);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [isHost, phase, roundIndex, phaseEndsAt, advancePhase]);

  /* ── round_reveal sinematik intro paneli: faz başında ~7 sn görünen,
     sonra kendiliğinden kaybolan sonuç kartı. Yalnız sunum; hiçbir veri/
     skor akışına dokunmaz. is-leaving ile son 500 ms'de yumuşak çıkış. ── */
  const [showIntroSummary, setShowIntroSummary] = useState(false);
  const [introLeaving, setIntroLeaving] = useState(false);
  useEffect(() => {
    if (phase !== "round_reveal") {
      setShowIntroSummary(false);
      setIntroLeaving(false);
      return;
    }
    setShowIntroSummary(true);
    setIntroLeaving(false);
    const leave = window.setTimeout(() => setIntroLeaving(true), 6500);
    const hide = window.setTimeout(() => setShowIntroSummary(false), 7000);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(hide);
    };
  }, [phase, roundIndex]);

  /* ── Watchdog: realtime event kaçarsa stale kalmayalım. Faz bitiminden
     3+ sn sonra hâlâ aynı fazdaysak oda satırını elle çekip uygula
     (out-of-order guard parent'taki applyRoomUpdate'te). ── */
  useEffect(() => {
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    const id = window.setInterval(() => {
      if (getSyncedNowMs() < phaseEndsAt + 3000) return;
      supabase
        .from("tevatur_rooms")
        .select("*")
        .eq("id", room.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) onRoomUpdateRef.current?.(data as TevaturRoom);
        });
    }, 5000);
    return () => window.clearInterval(id);
  }, [phase, roundIndex, phaseEndsAt, room.id]);

  /* ── Süreli fazların son 5 sn'sinde geri sayım sesi ──
     countdown20 tek cache instance'tan çalar (kontrol edilebilir); faz başına
     bir kez tetiklenir. Faz/tur değişince veya bileşen sökülünce durdurulur.
     getCountdownSoundMode()==="off" ise kullanıcı tercihine saygı duyulur;
     playSound zaten isSoundEnabled() ve autoplay hatalarını içeride yutar. */
  const countdownPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    if (getCountdownSoundMode() === "off") return;
    const remaining = Math.max(0, Math.ceil((phaseEndsAt - getSyncedNowMs()) / 1000));
    // observe_report'ta countdown son 10 sn'de (ambient durduğunda) devralır;
    // diğer fazlarda mevcut son 5 sn davranışı korunur.
    const countdownThreshold = phase === "observe_report" ? 10 : 5;
    if (remaining <= countdownThreshold && remaining > 0) {
      const key = `${roundIndex}:${phase}`;
      if (countdownPhaseRef.current !== key) {
        countdownPhaseRef.current = key;
        playSound("countdown20");
      }
    }
  }, [phase, roundIndex, phaseEndsAt, nowMs]);

  useEffect(() => {
    // Faz/tur değişince ya da ekrandan çıkınca geri sayımı sustur.
    return () => stopSound("countdown20");
  }, [phase, roundIndex]);

  /* ── observe_report ambient müziği (yalnız bu client; broadcast YOK) ──
     Faz observe_report VE kalan süre > 10 sn iken düşük sesle loop'lar; son
     10 sn'de durur ve countdown devralır. Yalnız bu faz; diğer tüm fazlarda
     (round_reveal/role_reveal/detective_guess/report_judgement/...) susar.
     playSound zaten isSoundEnabled() ve autoplay hatalarını yutar; ambient
     idempotenttir, ticker tekrarlarında baştan başlamaz. Faz değişince,
     süre dolunca ve bileşen sökülünce stopSound ile kesin durur. */
  useEffect(() => {
    const remaining =
      phaseEndsAt == null
        ? null
        : Math.max(0, Math.ceil((phaseEndsAt - getSyncedNowMs()) / 1000));
    const ambientOn =
      phase === "observe_report" && remaining != null && remaining > 10;
    if (ambientOn) {
      playSound("korNoktaReportAmbient");
    } else {
      stopSound("korNoktaReportAmbient");
    }
  }, [phase, roundIndex, phaseEndsAt, nowMs]);

  useEffect(() => {
    // Ekrandan / oyundan çıkınca ambient kesin dursun.
    return () => stopSound("korNoktaReportAmbient");
  }, []);

  /* ── Tur-lokal form state'leri (tur değişince sıfırlanır) ── */
  const [reportText, setReportText]         = useState("");
  const [reportError, setReportError]       = useState<string | null>(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [guess, setGuess]                   = useState<KnLatLng | null>(null);
  const [guessError, setGuessError]         = useState<string | null>(null);
  const [guessSubmitting, setGuessSubmitting] = useState(false);
  const [suspect, setSuspect]               = useState<string | null>(null);
  const [useful, setUseful]                 = useState<string | null>(null);
  const [judgementError, setJudgementError] = useState<string | null>(null);
  const [judgementSubmitting, setJudgementSubmitting] = useState(false);

  useEffect(() => {
    setReportText("");
    setReportError(null);
    setReportSubmitting(false);
    setGuess(null);
    setGuessError(null);
    setGuessSubmitting(false);
    setSuspect(null);
    setUseful(null);
    setJudgementError(null);
    setJudgementSubmitting(false);
  }, [roundIndex]);

  /* ── Durum okunamadıysa fallback ── */
  if (!state) {
    const fallbackBg = resolveKnBackground(null, null);
    return (
      <div
        className={`kn-screen ${fallbackBg.themeClass}`}
        style={{ "--kn-bg-image": `url("${fallbackBg.url}")` } as CSSProperties}
      >
        <div className="kn-card kn-card--center">
          <h2 className="kn-card__title">Oyun durumu okunamadı</h2>
          <p className="kn-card__desc">
            Bağlantı sorunlu olabilir. Lobiden çıkıp tekrar katılmayı dene.
          </p>
          <button className="btn btn-ghost kn-wide-btn" onClick={onExit}>
            ← Ana Menü
          </button>
        </div>
      </div>
    );
  }

  const round: KnRound = state.rounds[state.roundIndex];
  const scene = findKnScene(round.sceneId);
  const myRole = getKnRole(round, myId);

  /* ── Faz/rol'e göre Kör Nokta'ya özel arkaplan + tema (spec §2–4) ──
     Tüm gameplay ekranı `kn-screen` wrapper'ları bunu paylaşır; görsel
     yüklenmezse CSS koyu base + overlay ile okunur kalır (fallback). */
  const knBg = resolveKnBackground(state.phase, myRole);
  const knScreen = (extraClass = ""): {
    className: string;
    style: CSSProperties;
  } => ({
    className: `kn-screen${extraClass ? " " + extraClass : ""} ${knBg.themeClass}`,
    style: { "--kn-bg-image": `url("${knBg.url}")` } as CSSProperties,
  });

  const nameOf = (pid: string): string =>
    players.find(p => p.id === pid)?.name ?? "Ayrılan oyuncu";

  const remainingSec =
    state.phaseEndsAt == null
      ? null
      : Math.max(0, Math.ceil((state.phaseEndsAt - nowMs) / 1000));

  const reporterIds = Object.keys(round.assignments);
  const submittedCount = Object.keys(round.reports).length;
  const myReportSubmitted = !!round.reports[myId];
  const myCategory = round.assignments[myId] ?? null;

  /* ── Aksiyonlar ── */

  async function submitReport() {
    if (!scene || reportSubmitting || myReportSubmitted) return;
    const verdict = validateReport(reportText, scene.bannedWords);
    if (!verdict.ok) {
      setReportError(verdict.message);
      playSound("wrong");
      return;
    }
    playSound("click");
    setReportSubmitting(true);
    setReportError(null);
    const { data, error } = await supabase.rpc("tevatur_kn_submit_report", {
      p_room_id:     room.id,
      p_player_id:   myId,
      p_claim_token: claimToken,
      p_text:        reportText.trim(),
    });
    setReportSubmitting(false);
    if (error) {
      setReportError(describeKnGameError(error) ?? "Rapor gönderilemedi. Tekrar dene.");
      playSound("wrong");
      return;
    }
    if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
    playSound("correct");
  }

  async function submitGuess() {
    if (!guess || guessSubmitting) return;
    playSound("click");
    setGuessSubmitting(true);
    setGuessError(null);
    const { data, error } = await supabase.rpc("tevatur_kn_submit_guess", {
      p_room_id:     room.id,
      p_player_id:   myId,
      p_claim_token: claimToken,
      p_lat:         guess.lat,
      p_lng:         guess.lng,
    });
    setGuessSubmitting(false);
    if (error) {
      setGuessError(describeKnGameError(error) ?? "Tahmin gönderilemedi. Tekrar dene.");
      return;
    }
    if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
  }

  async function submitJudgement() {
    if (!suspect || judgementSubmitting) return;
    playSound("click");
    setJudgementSubmitting(true);
    setJudgementError(null);
    const { data, error } = await supabase.rpc("tevatur_kn_submit_judgement", {
      p_room_id:     room.id,
      p_player_id:   myId,
      p_claim_token: claimToken,
      p_suspect:     suspect,
      p_useful:      useful,
    });
    setJudgementSubmitting(false);
    if (error) {
      setJudgementError(
        describeKnGameError(error) ?? "Değerlendirme gönderilemedi. Tekrar dene.",
      );
      return;
    }
    if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
  }

  /* ── Ortak üst şerit ── */
  const topbar = (
    <div className="kn-topbar">
      <span className="kn-chip">
        Tur {state.roundIndex + 1}/{state.roundCount}
      </span>
      <span className="kn-chip">{PHASE_LABELS[state.phase]}</span>
      {remainingSec != null && state.phase !== "final_results" && (
        <span className={"kn-chip kn-chip--timer" + (remainingSec <= 5 ? " is-low" : "")}>
          ⏱ {remainingSec} sn
        </span>
      )}
      {myRole === "detective" && <span className="kn-chip kn-chip--detective">🕵️ Dedektif</span>}
      {myRole === "reporter" && <span className="kn-chip kn-chip--reporter">👁️ Raporcu</span>}
      {myRole === "mole" && <span className="kn-chip kn-chip--mole">🎭 Köstebek</span>}
    </div>
  );

  /* ════════ ROLE REVEAL ════════ */
  if (state.phase === "role_reveal") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          {myRole === "detective" && (
            <div className="kn-rolecard kn-rolecard--detective kn-anim-scale-in">
              <span className="kn-rolecard__eyebrow">Görev Dosyası</span>
              <span className="kn-rolecard__emoji" aria-hidden>🕵️</span>
              <h2 className="kn-rolecard__title">Dedektifsin</h2>
              <span className="kn-rolecard__rule" aria-hidden />
              <p className="kn-rolecard__desc">
                Fotoğrafı görmeyeceksin. Raporlara göre konumu bul.
              </p>
            </div>
          )}
          {myRole === "reporter" && (
            <div className="kn-rolecard kn-rolecard--reporter kn-anim-scale-in">
              <span className="kn-rolecard__eyebrow">Tanık Brifingi</span>
              <span className="kn-rolecard__emoji" aria-hidden>👁️</span>
              <h2 className="kn-rolecard__title">Raporcusun</h2>
              <span className="kn-rolecard__rule" aria-hidden />
              <p className="kn-rolecard__desc">
                Kategorine uygun kısa ve faydalı bir rapor yaz.
              </p>
            </div>
          )}
          {myRole === "mole" && (
            <div className="kn-rolecard kn-rolecard--mole kn-anim-scale-in">
              <span className="kn-rolecard__eyebrow">Gizli Talimat</span>
              <span className="kn-rolecard__emoji" aria-hidden>🎭</span>
              <h2 className="kn-rolecard__title">Köstebeksin</h2>
              <span className="kn-rolecard__rule" aria-hidden />
              <p className="kn-rolecard__desc">
                Dedektifi yanlış yere yönlendir ama yakalanma.
              </p>
            </div>
          )}
          {myRole === "spectator" && (
            <div className="kn-rolecard kn-anim-scale-in">
              <span className="kn-rolecard__eyebrow">Gözlemci</span>
              <span className="kn-rolecard__emoji" aria-hidden>👀</span>
              <h2 className="kn-rolecard__title">İzleyicisin</h2>
              <span className="kn-rolecard__rule" aria-hidden />
              <p className="kn-rolecard__desc">Bu turda rol almıyorsun.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ════════ SAHNE BULUNAMADI (yerel havuz ↔ plan uyuşmazlığı) ════════ */
  if (
    !scene &&
    (state.phase === "observe_report" || state.phase === "detective_guess") &&
    myRole !== "detective"
  ) {
    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-card kn-card--center">
            <h2 className="kn-card__title">Sahne bulunamadı</h2>
            <p className="kn-card__desc">
              Bu tur için sahne verisi yüklenemedi. Uygulamanın güncel
              sürümünü kullandığından emin ol.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ OBSERVE + GUESS — raporcu/köstebek görünümü ════════
     Panorama iki faz boyunca mount kalır (texture bir kez yüklenir). */
  if (
    (state.phase === "observe_report" || state.phase === "detective_guess") &&
    (myRole === "reporter" || myRole === "mole")
  ) {
    const isObserve = state.phase === "observe_report";
    return (
      <div {...knScreen("kn-screen--stage")}>
        <Panorama360 src={scene?.imagePath ?? ""} className="kn-stage-pano" />
        <div className="kn-stage-top">{topbar}</div>

        <div className={"kn-reportbar kn-anim-fade-up" + (myRole === "mole" ? " kn-reportbar--mole" : "")}>
          {isObserve && !myReportSubmitted && myCategory && (
            <>
              <div className="kn-reportbar__head">
                <span className="kn-mission__eyebrow">
                  {myRole === "mole" ? "Gizli Görev" : "Sahneyi İncele"}
                </span>
                <span className="kn-reportbar__category">
                  Kategori: {KN_CATEGORY_LABELS[myCategory]}
                </span>
                <span className="kn-reportbar__hint">{KN_CATEGORY_HINTS[myCategory]}</span>
                {myRole === "mole" && (
                  <span className="kn-reportbar__mole-note">
                    🎭 Dedektifi yanılt ama fazla belli etme.
                  </span>
                )}
              </div>
              <div className="kn-reportbar__row">
                <input
                  className="kn-reportbar__input"
                  type="text"
                  value={reportText}
                  maxLength={60}
                  placeholder="2–5 kelimelik rapor yaz…"
                  onChange={e => {
                    setReportText(e.target.value);
                    if (reportError) setReportError(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") void submitReport();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-accent kn-reportbar__send"
                  onClick={() => void submitReport()}
                  disabled={reportSubmitting || reportText.trim().length === 0}
                >
                  {reportSubmitting ? "Gönderiliyor…" : "Raporu Gönder"}
                </button>
              </div>
              {reportError && <p className="kn-error">{reportError}</p>}
            </>
          )}

          {isObserve && myReportSubmitted && (
            <div className="kn-reportbar__done kn-anim-scale-in">
              <span className="kn-reportbar__done-check">✓ Raporun iletildi</span>
              <span className="kn-reportbar__done-sub">
                Diğer raporcular bekleniyor ({submittedCount}/{reporterIds.length})
              </span>
            </div>
          )}

          {!isObserve && (
            <div className="kn-reportbar__done">
              <span className="kn-reportbar__done-check kn-reportbar__done-check--neutral">🕵️ Dedektif karar veriyor…</span>
              <span className="kn-reportbar__done-sub">
                Raporlarınızdan yola çıkarak haritada tahmin yapıyor.
              </span>
              <span className="kn-reportbar__done-sub">
                {myReportSubmitted && round.reports[myId]
                  ? `Raporun: "${round.reports[myId].text}"`
                  : "Bu tur rapor göndermedin."}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ════════ OBSERVE — dedektif bekleme ════════ */
  if (state.phase === "observe_report" && myRole === "detective") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-briefing kn-anim-scale-in">
            <div className="kn-radar" aria-hidden />
            <span className="kn-briefing__eyebrow">İstihbarat Bekleniyor</span>
            <h2 className="kn-briefing__title">Raporlar Bekleniyor</h2>
            <p className="kn-briefing__desc">
              Tanıklar sahneyi inceliyor. Birazdan gizli raporlar önüne düşecek.
            </p>
            <span className="kn-progress-pill">
              {submittedCount}/{reporterIds.length} rapor geldi
            </span>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ GUESS — dedektif tahmin ekranı (yalnız pin) ════════
     Şüpheli / en faydalı seçimleri report_judgement fazına taşındı. */
  if (state.phase === "detective_guess" && myRole === "detective") {
    const canSubmitGuess = !!guess && !guessSubmitting;

    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-guess">
          <div className="kn-guess__reports">
            <header className="kn-guess__head">
              <span className="kn-guess__eyebrow">Dosya Hazır</span>
              <h2 className="kn-guess__title">Gizli Raporlar</h2>
              <p className="kn-guess__sub">Raporları incele ve konumu işaretle.</p>
            </header>

            {round.reportOrder.map((pid, i) => {
              const report = round.reports[pid] ?? null;
              const category = round.assignments[pid];
              return (
                <article
                  key={pid}
                  className="kn-report-card kn-report-card--file kn-anim-fade-up"
                  style={{ "--kn-delay": `${i * 0.06}s` } as CSSProperties}
                >
                  <div className="kn-report-card__meta">
                    Rapor {knReportLetter(i)} · {KN_CATEGORY_LABELS[category]}
                  </div>
                  {report ? (
                    <p className="kn-report-card__text">“{report.text}”</p>
                  ) : (
                    <p className="kn-report-card__text kn-report-card__text--missing">
                      Rapor verilmedi
                    </p>
                  )}
                </article>
              );
            })}

            <div className="kn-guess__checklist">
              <span className={guess ? "is-done" : ""}>📍 Haritaya pin koy</span>
            </div>
          </div>

          <div className="kn-guess__map-panel">
            <KorNoktaGuessMap
              key={`pick-${state.roundIndex}`}
              mode="pick"
              onGuessChange={setGuess}
              className="kn-guess__map"
            />
            <button
              type="button"
              className="btn btn-accent kn-wide-btn kn-submit-cta"
              onClick={() => void submitGuess()}
              disabled={!canSubmitGuess}
            >
              {guessSubmitting ? "Gönderiliyor…" : "Tahmini Gönder"}
            </button>
            {guessError && <p className="kn-error">{guessError}</p>}
          </div>
        </div>
      </div>
    );
  }

  /* ════════ GUESS REVEAL — herkes: gerçek konum + dedektif tahmini ════════
     Roller ve rapor sahipleri hâlâ gizli; yalnız harita karşılaştırması. */
  if (state.phase === "guess_reveal") {
    const mapResult = round.mapResult;
    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-reveal">
          <header className="kn-reveal__head kn-reveal__head--panel kn-anim-scale-in">
            <span className="kn-reveal__eyebrow">Tahmin Kilitlendi</span>
            <h2 className="kn-reveal__title">Gerçek Konumla Karşılaştırılıyor</h2>
            <p className="kn-reveal__sub">
              Roller ve rapor sahipleri hâlâ gizli.
            </p>
          </header>

          <div className="kn-reveal__map-wrap">
            <KorNoktaGuessMap
              key={`guess-reveal-${state.roundIndex}`}
              mode="reveal"
              revealGuess={round.guess ? { lat: round.guess.lat, lng: round.guess.lng } : null}
              revealActual={scene ? scene.location : null}
              className="kn-reveal__map"
            />
          </div>

          <div className="kn-reveal__stats">
            <div className="kn-stat">
              <span className="kn-stat__value">{formatDistanceKm(mapResult?.distanceKm)}</span>
              <span className="kn-stat__label">Mesafe</span>
            </div>
            <div className="kn-stat">
              <span className="kn-stat__value">
                {(mapResult?.mapScore ?? 0).toLocaleString("tr-TR")}
                <span className="kn-stat__max"> / 5000</span>
              </span>
              <span className="kn-stat__label">Harita Skoru</span>
            </div>
          </div>

          {round.guess == null && (
            <p className="kn-reveal__notice">Dedektif süresinde tahmin yapmadı.</p>
          )}
          <p className="kn-reveal__notice">
            Rapor sahipleri ve roller henüz gizli. Sırada: rapor değerlendirme.
          </p>
        </div>
      </div>
    );
  }

  /* ════════ REPORT JUDGEMENT — dedektif şüpheli + en faydalıyı seçer ════════
     Nickler hâlâ gizli; dedektif gerçek konumu gördükten sonra değerlendirir. */
  if (state.phase === "report_judgement") {
    if (myRole !== "detective") {
      return (
        <div {...knScreen("kn-cine")}>
          {topbar}
          <div className="kn-center-wrap">
            <div className="kn-briefing kn-anim-scale-in">
              <div className="kn-radar" aria-hidden />
              <span className="kn-briefing__eyebrow">Karar Aşaması</span>
              <h2 className="kn-briefing__title">Dedektif Değerlendiriyor</h2>
              <p className="kn-briefing__desc">
                Şüpheli raporu ve en faydalı raporu seçiyor. Kimlikler birazdan
                açıklanacak.
              </p>
            </div>
          </div>
        </div>
      );
    }

    const usefulSelectable = round.reportOrder.filter(pid => !!round.reports[pid]);
    const usefulRequired = usefulSelectable.length > 0;
    const canSubmitJudgement =
      !!suspect && (!usefulRequired || !!useful) && !judgementSubmitting;

    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-judge">
          <header className="kn-guess__head kn-anim-fade-up">
            <span className="kn-guess__eyebrow">Raporları Değerlendir</span>
            <h2 className="kn-guess__title">Köstebek Var mıydı?</h2>
            <p className="kn-guess__sub">
              Gerçek konumu gördün. En faydalı raporu ve şüpheliyi seç.
            </p>
          </header>

          {round.reportOrder.map((pid, i) => {
            const report = round.reports[pid] ?? null;
            const category = round.assignments[pid];
            return (
              <article
                key={pid}
                className={
                  "kn-report-card" +
                  (suspect === pid ? " is-suspect" : "") +
                  (useful === pid ? " is-useful" : "")
                }
              >
                <div className="kn-report-card__meta">
                  Rapor {knReportLetter(i)} · {KN_CATEGORY_LABELS[category]}
                </div>
                {report ? (
                  <p className="kn-report-card__text">“{report.text}”</p>
                ) : (
                  <p className="kn-report-card__text kn-report-card__text--missing">
                    Rapor verilmedi
                  </p>
                )}
                <div className="kn-report-card__actions">
                  <button
                    type="button"
                    className={"kn-pick-btn kn-pick-btn--suspect" + (suspect === pid ? " is-on" : "")}
                    onClick={() => {
                      playSound("click");
                      setSuspect(prev => (prev === pid ? null : pid));
                    }}
                  >
                    🎭 Köstebek bu
                  </button>
                  {report && (
                    <button
                      type="button"
                      className={"kn-pick-btn kn-pick-btn--useful" + (useful === pid ? " is-on" : "")}
                      onClick={() => {
                        playSound("click");
                        setUseful(prev => (prev === pid ? null : pid));
                      }}
                    >
                      ⭐ En faydalı
                    </button>
                  )}
                </div>
              </article>
            );
          })}

          <button
            type="button"
            className={"kn-pick-btn kn-pick-btn--none" + (suspect === "none" ? " is-on" : "")}
            onClick={() => {
              playSound("click");
              setSuspect(prev => (prev === "none" ? null : "none"));
            }}
          >
            Köstebek yoktu
          </button>

          <div className="kn-guess__checklist">
            <span className={suspect ? "is-done" : ""}>🎭 Şüpheni seç</span>
            {usefulRequired && (
              <span className={useful ? "is-done" : ""}>⭐ En faydalıyı seç</span>
            )}
          </div>

          <button
            type="button"
            className="btn btn-accent kn-wide-btn kn-submit-cta"
            onClick={() => void submitJudgement()}
            disabled={!canSubmitJudgement}
          >
            {judgementSubmitting ? "Gönderiliyor…" : "Değerlendirmeyi Gönder"}
          </button>
          {judgementError && <p className="kn-error">{judgementError}</p>}
        </div>
      </div>
    );
  }

  /* ════════ ROUND REVEAL ════════ */
  if (state.phase === "round_reveal") {
    const result = round.result;
    const actual = scene ? scene.location : null;
    const isLastRound = state.roundIndex + 1 >= state.roundCount;
    const distanceLabel = formatDistanceKm(result?.distanceKm);

    /* Sunum: tur sonucu + en faydalı rapor + kümülatif liderlik (ilk 3). */
    const outcome = resolveRoundOutcome(round);
    const usefulId = round.judgement?.useful ?? null;
    const leaderboard = [...state.playerOrder]
      .sort((a, b) => (state.totals[b] ?? 0) - (state.totals[a] ?? 0))
      .slice(0, 3);

    // round_reveal sohbeti her tur taze başlasın: bu turun reveal fazının
    // başlangıç anı = phaseEndsAt − 15000 (server reveal süresi, migration
    // 20260713120000: tevatur_kn_now_ms() + 15000). Sunucu saatiyle hesaplanır,
    // tüm client'larda aynıdır ve duel_messages.created_at (server now()) ile
    // birebir kıyaslanır. LobbyChat yalnız bu andan sonraki mesajları gösterir.
    const REVEAL_PHASE_MS = 15000;
    const revealChatSince =
      state.phaseEndsAt != null
        ? new Date(state.phaseEndsAt - REVEAL_PHASE_MS).toISOString()
        : undefined;

    return (
      <div {...knScreen()}>
        {topbar}

        {/* Faz başında ~7 sn görünen sinematik sonuç kartı (intro). Kalıcı
            layout elemanı değil; pointer-events:none ile alttaki akışı engellemez.
            document.body'ye portal'lanır: kn-screen'in `isolation: isolate`
            stacking context'inden ve Leaflet pane'lerinden tamamen kurtulup
            her şeyin üstünde (z-index 9999) merkezde görünür. */}
        {showIntroSummary && createPortal(
          <div
            className={"kn-intro-overlay" + (introLeaving ? " is-leaving" : "")}
            aria-live="polite"
          >
            <div className={"kn-intro-card kn-intro-card--" + outcome.tone}>
              <span className="kn-intro-card__eyebrow">Dosya Açıldı</span>
              <span className="kn-intro-card__title">{outcome.title}</span>
              <span className="kn-intro-card__sub">{outcome.sub}</span>
              <div className="kn-intro-card__divider" aria-hidden />
              <div className="kn-intro-card__lines">
                <span className="kn-intro-card__mole">
                  {round.moleId ? (
                    <>🎭 Köstebek: <strong>{nameOf(round.moleId)}</strong></>
                  ) : (
                    <>🎭 Bu turda köstebek yoktu</>
                  )}
                </span>
                {usefulId && (
                  <span className="kn-intro-card__useful">
                    ⭐ En faydalı rapor: <strong>{nameOf(usefulId)}</strong>
                  </span>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

        <div className="kn-reveal-shell">
        <div className="kn-reveal">
          <header className="kn-reveal__head kn-reveal__head--panel kn-anim-scale-in">
            <span className="kn-reveal__eyebrow">Dosya Açıldı</span>
            <h2 className="kn-reveal__title">Gerçek Konum ve Roller</h2>
            {scene && (
              <p className="kn-reveal__scene">
                {scene.title} · {scene.regionLabel} · {scene.yearLabel}
              </p>
            )}
          </header>

          <div className="kn-reveal__map-wrap">
            <KorNoktaGuessMap
              key={`reveal-${state.roundIndex}`}
              mode="reveal"
              revealGuess={round.guess ? { lat: round.guess.lat, lng: round.guess.lng } : null}
              revealActual={actual}
              className="kn-reveal__map"
            />
          </div>

          <div className="kn-reveal__stats">
            <div className="kn-stat">
              <span className="kn-stat__value">{distanceLabel}</span>
              <span className="kn-stat__label">Uzaklık</span>
            </div>
            <div className="kn-stat">
              <span className="kn-stat__value">
                {(result?.mapScore ?? 0).toLocaleString("tr-TR")}
                <span className="kn-stat__max"> / 5000</span>
              </span>
              <span className="kn-stat__label">Harita Skoru</span>
            </div>
            <div className="kn-stat kn-stat--roundpts">
              <span className="kn-stat__label">Tur Puanları</span>
              <div className="kn-roundpts">
                {state.playerOrder.map(pid => {
                  const roundPts = result?.scores[pid] ?? 0;
                  const isMolePid = round.moleId === pid;
                  return (
                    <div key={pid} className="kn-roundpts__row">
                      <span className="kn-roundpts__name">
                        {nameOf(pid)}
                        {isMolePid && (
                          <span
                            className="kn-roundpts__mole"
                            title="Bu turun köstebeği"
                            aria-label="Köstebek"
                          >
                            🎭
                          </span>
                        )}
                      </span>
                      <span
                        className={"kn-roundpts__delta" + (roundPts > 0 ? " is-gain" : "")}
                      >
                        +{roundPts.toLocaleString("tr-TR")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {round.guess == null && (
            <p className="kn-reveal__notice">Dedektif süresinde tahmin yapmadı.</p>
          )}

          {round.moleId && (
            <p className="kn-reveal__notice">
              {result?.caught
                ? `🎯 Köstebek: ${nameOf(round.moleId)} — yakalandı.`
                : `🎭 Köstebek: ${nameOf(round.moleId)} — sıyrıldı.`}
            </p>
          )}

          <div className="kn-lead kn-anim-fade-up">
            <span className="kn-lead__title">Liderlik</span>
            {leaderboard.map((pid, i) => (
              <div key={pid} className={"kn-lead__row" + (i === 0 ? " is-top" : "")}>
                <span className="kn-lead__rank">{i + 1}</span>
                <span className="kn-lead__name">
                  {nameOf(pid)}
                  {pid === myId && <span className="kn-lead__me"> · sen</span>}
                </span>
                <span className="kn-lead__score">
                  {(state.totals[pid] ?? 0).toLocaleString("tr-TR")}
                </span>
              </div>
            ))}
          </div>

          <div className="kn-reveal__reports">
            {round.reportOrder.map((pid, i) => {
              const report = round.reports[pid] ?? null;
              const category = round.assignments[pid];
              const isMole = round.moleId === pid;
              return (
                <article
                  key={pid}
                  className={"kn-report-card kn-report-card--reveal" + (isMole ? " is-mole" : "")}
                >
                  <div className="kn-report-card__meta">
                    Rapor {knReportLetter(i)} · {KN_CATEGORY_LABELS[category]}
                  </div>
                  {report ? (
                    <p className="kn-report-card__text">“{report.text}”</p>
                  ) : (
                    <p className="kn-report-card__text kn-report-card__text--missing">
                      Rapor verilmedi
                    </p>
                  )}
                  <div className="kn-report-card__author">
                    <span>
                      Yazan: <strong>{nameOf(pid)}</strong>
                    </span>
                    <span className={"kn-role-tag" + (isMole ? " kn-role-tag--mole" : "")}>
                      {isMole ? "Köstebek" : "Dürüst Raporcu"}
                    </span>
                  </div>
                  {(round.judgement?.suspect === pid || round.judgement?.useful === pid) && (
                    <div className="kn-report-card__badges">
                      {round.judgement?.suspect === pid && (
                        <span className="kn-badge kn-badge--suspect">🎭 Dedektif şüphelendi</span>
                      )}
                      {round.judgement?.useful === pid && (
                        <span className="kn-badge kn-badge--useful">⭐ En faydalı seçildi</span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          {result != null && result.mapScore < KN_GOOD_GUESS_THRESHOLD && round.moleId && (
            <p className="kn-reveal__notice">
              Tahmin 1500 puanın altında kaldı — köstebek için verimli bir tur.
            </p>
          )}

          <div className="kn-reveal__actions">
            {/* Sonraki tura geçiş otomatik: round_reveal süresi (phaseEndsAt)
                bitince host'un faz-ilerletme interval'ı advancePhase'i tetikler
                ve tüm oyuncular realtime ile senkron geçer. Manuel buton yok. */}
            <p className="kn-reveal__waiting">
              {isLastRound ? "Final skorları" : "Sonraki tur"} birazdan…
            </p>
          </div>
        </div>

        {/* Dosya açıldıktan sonra oyuncular yorumlaşabilsin (lobi chat'ini
            reuse eder; mesajlar aynı oda — duel_messages.room_code). Yalnız
            round_reveal'de mount edilir; tahmin/rapor/değerlendirme
            ekranlarında hiç render edilmez, dedektifi etkileyemez. */}
        <aside className="kn-reveal-chat">
          <LobbyChat
            key={`reveal-chat-${state.roundIndex}`}
            roomCode={room.code}
            playerName={nameOf(myId)}
            sendMode="tevatur"
            playerId={myId}
            claimToken={claimToken}
            minCreatedAt={revealChatSince}
          />
        </aside>
        </div>
      </div>
    );
  }

  /* ════════ FINAL RESULTS ════════ */
  if (state.phase === "final_results") {
    const ranked = [...state.playerOrder].sort(
      (a, b) => (state.totals[b] ?? 0) - (state.totals[a] ?? 0),
    );
    const champion = ranked[0] ?? null;
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-card kn-final kn-anim-scale-in">
            <span className="kn-final__eyebrow">Dosya Kapandı</span>
            <h2 className="kn-card__title">Şampiyon Belirlendi</h2>

            {champion && (
              <div className="kn-final__winner">
                <span className="kn-final__crown" aria-hidden>🏆</span>
                <span className="kn-final__winner-label">Birinci</span>
                <span className="kn-final__winner-name">
                  {nameOf(champion)}
                  {champion === myId && " · sen"}
                </span>
                <span className="kn-final__winner-score">
                  {(state.totals[champion] ?? 0).toLocaleString("tr-TR")} puan
                </span>
              </div>
            )}

            <div className="kn-final__board">
              {ranked.map((pid, i) => (
                <div key={pid} className={"kn-final__row" + (i === 0 ? " is-winner" : "")}>
                  <span className="kn-final__rank">{i === 0 ? "🏆" : `${i + 1}.`}</span>
                  <span className="kn-final__name">
                    {nameOf(pid)}
                    {pid === myId && <span className="kn-final__me"> (sen)</span>}
                  </span>
                  <span className="kn-final__total">
                    {(state.totals[pid] ?? 0).toLocaleString("tr-TR")}
                  </span>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-accent kn-wide-btn"
              onClick={() => {
                playSound("click");
                onExit();
              }}
            >
              Ana Menüye Dön
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* Beklenmeyen faz/rol kombinasyonu (ör. izleyici) — nötr bekleme. */
  return (
    <div {...knScreen()}>
      {topbar}
      <div className="kn-center-wrap">
        <div className="kn-card kn-card--center">
          <h2 className="kn-card__title">Tur sürüyor…</h2>
          <p className="kn-card__desc">Diğer oyuncular hamlelerini yapıyor.</p>
        </div>
      </div>
    </div>
  );
}
