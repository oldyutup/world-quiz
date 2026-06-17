/**
 * KorNoktaGame — Kör Nokta TAKIM modu gameplay (game_state version 2).
 *
 * KorNoktaMode lobby'sinin altında, room.status 'playing'/'finished' iken
 * render edilir. Oyun durumu tevatur_rooms.game_state jsonb blob'undan okunur
 * ve mevcut realtime UPDATE aboneliğiyle akar — bu bileşen kendi kanalını
 * AÇMAZ, room prop'u değiştikçe yeniden render olur.
 *
 * Takım modeli: iki takım (Mavi/Kırmızı) aynı sahneyle oynar. Her turda her
 * takımda 1 dedektif rotasyonla döner; dedektif sahneyi görmez, kendi takımının
 * (anonim) raporlarını okuyup haritada tahmin yapar. Köstebek (yalnız 3v3+)
 * raporunu KARŞI takım dedektifine gönderir; kimliği hiç açıklanmaz. Puanlama
 * mesafe bazlı 0–5000 (takım başına, tur tur birikir); finalde toplamı yüksek
 * takım kazanır. Şüpheli seçme / köstebek yakalama YOK.
 *
 * Yetki: faz ilerletme host-authoritative (advance_phase, expected-state guard);
 * rapor/tahmin yazmaları yalnız ilgili oyuncunun RPC'siyle olur.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { supabase, type TevaturRoom, type TevaturPlayer } from "../../lib/supabase";
import { getSyncedNowMs, initServerClockSync } from "../../lib/serverClock";
import { playSound, stopSound, getCountdownSoundMode } from "../../lib/sound";
import {
  KN_CATEGORY_HINTS,
  KN_CATEGORY_LABELS,
  KN_TEAM_LABELS,
  findKnScene,
  getKnRole,
  getKnTeam,
  knReportLetter,
  parseKnGameState,
  type KnGameState,
  type KnPhase,
  type KnTeam,
  type KnTeamRound,
} from "./korNoktaGameTypes";
import { validateReport } from "./reportValidation";
import { resolveKnBackground } from "./korNoktaBackgrounds";
import Panorama360 from "./Panorama360";
import KorNoktaGuessMap, { type KnLatLng, type KnRevealGuess } from "./KorNoktaGuessMap";
import LobbyChat from "../../components/LobbyChat";
import XpGainBar from "../../components/XpGainBar";
import {
  awardXpEvent,
  calculateKorNoktaXp,
  type MatchResult,
  type XpBreakdown,
} from "../../lib/progression";
import { recordGameComplete, recordOnlineMatchResult } from "../../lib/achievementStats";
import "./KorNoktaGame.css";

/** Takım renkleri — harita marker'ları ve panellerde kullanılır. */
const TEAM_COLORS: Record<KnTeam, string> = {
  blue: "#4f8bff",
  red:  "#ef4444",
};

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
  if (msg.includes("game_not_active"))   return "Oyun aktif değil.";
  if (msg.includes("unauthorized"))
    return "Yetki hatası. Sayfayı yenileyip tekrar dene.";
  return null;
}

const PHASE_LABELS: Record<KnPhase, string> = {
  role_reveal:      "Roller",
  observe_report:   "İnceleme",
  detective_guess:  "Tahmin",
  round_reveal:     "Tur Sonucu",
  final_results:    "Sonuçlar",
};

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
  /** RPC cevaplarını ve watchdog refetch'lerini parent'ın room state'ine uygular. */
  onRoomUpdate?: (room: TevaturRoom) => void;
  onExit: () => void;
}

interface KnXpView {
  awarded: boolean;
  xpEarned: number;
  prevTotalXp: number;
  totalXp: number;
  prevModeXp: number;
  modeXp: number;
  breakdown: XpBreakdown;
  dismissed: boolean;
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

  /* ── Server clock ── */
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
      if (getSyncedNowMs() >= phaseEndsAt + 600) {
        void advancePhase(roundIndex, phase);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [isHost, phase, roundIndex, phaseEndsAt, advancePhase]);

  /* ── Watchdog: realtime event kaçarsa stale kalmayalım ── */
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

  /* ── Süreli fazların son saniyelerinde geri sayım sesi ── */
  const countdownPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    if (getCountdownSoundMode() === "off") return;
    const remaining = Math.max(0, Math.ceil((phaseEndsAt - getSyncedNowMs()) / 1000));
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
    return () => stopSound("countdown20");
  }, [phase, roundIndex]);

  /* ── observe_report ambient müziği (yalnız bu client) ── */
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
    return () => stopSound("korNoktaReportAmbient");
  }, []);

  /* ── Tur-lokal form state'leri (tur değişince sıfırlanır) ── */
  const [reportText, setReportText]         = useState("");
  const [reportError, setReportError]       = useState<string | null>(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [guess, setGuess]                   = useState<KnLatLng | null>(null);
  const [guessError, setGuessError]         = useState<string | null>(null);
  const [guessSubmitting, setGuessSubmitting] = useState(false);

  useEffect(() => {
    setReportText("");
    setReportError(null);
    setReportSubmitting(false);
    setGuess(null);
    setGuessError(null);
    setGuessSubmitting(false);
  }, [roundIndex]);

  /* ── Maç sonu XP (her oyuncu kendi profili, idempotent RPC) ── */
  const myProfileId = players.find(p => p.id === myId)?.profile_id ?? null;
  const [xpView, setXpView] = useState<KnXpView | null>(null);
  const xpAwardedRef = useRef(false);

  const myTeamForXp: KnTeam | null = state ? getKnTeam(state, myId) : null;
  const blueTotalForXp = state?.totals.blue ?? 0;
  const redTotalForXp = state?.totals.red ?? 0;

  useEffect(() => {
    if (phase !== "final_results") return;
    if (xpAwardedRef.current) return;
    if (!myProfileId || !myTeamForXp) return;
    xpAwardedRef.current = true;

    const myTotal = myTeamForXp === "blue" ? blueTotalForXp : redTotalForXp;
    const otherTotal = myTeamForXp === "blue" ? redTotalForXp : blueTotalForXp;
    const result: MatchResult =
      myTotal > otherTotal ? "win" : myTotal < otherTotal ? "loss" : "draw";

    const breakdown = calculateKorNoktaXp({ result });
    breakdown.bonusLabelText = undefined;

    recordOnlineMatchResult(result);
    recordGameComplete({ modeFamily: "blindspot" });

    const profileId = myProfileId;
    (async () => {
      const res = await awardXpEvent({
        profileId,
        modeKey: "kornokta",
        roomId: room.id,
        xpEarned: breakdown.total,
        result,
        details: {
          team: myTeamForXp,
          blue_total: blueTotalForXp,
          red_total: redTotalForXp,
          breakdown,
        },
      });
      if (res.error) {
        console.error("[KorNokta] XP yazılamadı:", res.error);
        return;
      }
      const prevModeXp = res.awarded ? Math.max(0, res.modeXp - res.xpEarned) : res.modeXp;
      const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;
      setXpView({
        awarded: res.awarded,
        xpEarned: res.xpEarned,
        prevTotalXp,
        totalXp: res.totalXp,
        prevModeXp,
        modeXp: res.modeXp,
        breakdown,
        dismissed: false,
      });
    })();
  }, [phase, myProfileId, myTeamForXp, blueTotalForXp, redTotalForXp, room.id]);

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

  const round: KnTeamRound = state.rounds[state.roundIndex];
  const scene = findKnScene(round.sceneId);
  const myRole = getKnRole(round, myId);
  const myTeam = getKnTeam(state, myId);

  const knBg = resolveKnBackground(state.phase, myRole);
  const knScreen = (extraClass = ""): { className: string; style: CSSProperties } => ({
    className: `kn-screen${extraClass ? " " + extraClass : ""} ${knBg.themeClass}`,
    style: { "--kn-bg-image": `url("${knBg.url}")` } as CSSProperties,
  });

  const nameOf = (pid: string | null | undefined): string =>
    (pid && players.find(p => p.id === pid)?.name) || "Ayrılan oyuncu";

  const remainingSec =
    state.phaseEndsAt == null
      ? null
      : Math.max(0, Math.ceil((state.phaseEndsAt - nowMs) / 1000));

  const myCategory = round.assignments[myId] ?? null;
  const myReportSubmitted = !!round.reports[myId];
  const reporterIds = Object.keys(round.assignments);
  const submittedCount = Object.keys(round.reports).length;
  const myGuessSubmitted = myTeam ? !!round.guesses[myTeam] : false;

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
      {myTeam && (
        <span className={"kn-chip kn-chip--team kn-chip--team-" + myTeam}>
          {myTeam === "blue" ? "🔵 Mavi" : "🔴 Kırmızı"}
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
                Fotoğrafı görmeyeceksin. Takımının raporlarına göre konumu bul.
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
                Kategorine uygun kısa ve faydalı bir rapor yaz; dedektifine yardım et.
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
                Raporun karşı takımın dedektifine gidecek. Onu yanlış yere yönlendir.
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

  /* ════════ SAHNE BULUNAMADI (raporcu/köstebek görünümünde) ════════ */
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

  /* ════════ OBSERVE + GUESS — raporcu/köstebek görünümü ════════ */
  if (
    (state.phase === "observe_report" || state.phase === "detective_guess") &&
    (myRole === "reporter" || myRole === "mole")
  ) {
    const isObserve = state.phase === "observe_report";
    return (
      <div {...knScreen("kn-screen--stage")}>
        <Panorama360 src={scene?.imagePath ?? ""} className="kn-stage-pano" attribution={scene?.attribution} mirrorX={scene?.sourceType === "real_world"} />
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
                    🎭 Raporun karşı takım dedektifine gidecek — yanılt ama belli etme.
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
              <span className="kn-reportbar__done-check kn-reportbar__done-check--neutral">🕵️ Dedektifler karar veriyor…</span>
              <span className="kn-reportbar__done-sub">
                İki takım dedektifi de raporlardan yola çıkarak haritada tahmin yapıyor.
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
              Takımının tanıkları sahneyi inceliyor. Birazdan gizli raporlar önüne düşecek.
            </p>
            <span className="kn-progress-pill">
              {submittedCount}/{reporterIds.length} rapor geldi
            </span>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ GUESS — dedektif tahmin ekranı (kendi takımının raporları) ════════ */
  if (state.phase === "detective_guess" && myRole === "detective") {
    if (myGuessSubmitted) {
      return (
        <div {...knScreen("kn-cine")}>
          {topbar}
          <div className="kn-center-wrap">
            <div className="kn-briefing kn-anim-scale-in">
              <div className="kn-radar" aria-hidden />
              <span className="kn-briefing__eyebrow">Tahmin Kilitlendi</span>
              <h2 className="kn-briefing__title">Diğer Dedektif Bekleniyor</h2>
              <p className="kn-briefing__desc">
                Tahminin kaydedildi. İki takım da tahmin yapınca ortak sonuç açılacak.
              </p>
            </div>
          </div>
        </div>
      );
    }

    const myReportOrder = myTeam ? round.reportOrder[myTeam] : [];
    const canSubmitGuess = !!guess && !guessSubmitting;

    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-guess">
          <div className="kn-guess__reports">
            <header className="kn-guess__head">
              <span className="kn-guess__eyebrow">Dosya Hazır</span>
              <h2 className="kn-guess__title">Gizli Raporlar</h2>
              <p className="kn-guess__sub">Takımının raporlarını incele ve konumu işaretle.</p>
            </header>

            {myReportOrder.map((pid, i) => {
              const report = round.reports[pid] ?? null;
              const category = round.assignments[pid];
              return (
                <article
                  key={pid}
                  className="kn-report-card kn-report-card--file kn-anim-fade-up"
                  style={{ "--kn-delay": `${i * 0.06}s` } as CSSProperties}
                >
                  <div className="kn-report-card__meta">
                    Rapor {knReportLetter(i)}{category ? ` · ${KN_CATEGORY_LABELS[category]}` : ""}
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

  /* ════════ GUESS — dedektif olmayan: bekleme ════════ */
  if (state.phase === "detective_guess") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-briefing kn-anim-scale-in">
            <div className="kn-radar" aria-hidden />
            <span className="kn-briefing__eyebrow">Karar Aşaması</span>
            <h2 className="kn-briefing__title">Dedektifler Tahmin Yapıyor</h2>
            <p className="kn-briefing__desc">
              İki takımın dedektifi de haritada konum seçiyor. Ortak sonuç birazdan açılacak.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ ROUND REVEAL — ortak sonuç ekranı (iki takım yan yana) ════════ */
  if (state.phase === "round_reveal") {
    const actual = scene ? scene.location : null;
    const resB = round.results?.blue ?? null;
    const resR = round.results?.red ?? null;
    const guessB = round.guesses.blue;
    const guessR = round.guesses.red;
    const isLastRound = state.roundIndex + 1 >= state.roundCount;

    const revealGuesses: KnRevealGuess[] = [];
    if (guessB) revealGuesses.push({ lat: guessB.lat, lng: guessB.lng, color: TEAM_COLORS.blue });
    if (guessR) revealGuesses.push({ lat: guessR.lat, lng: guessR.lng, color: TEAM_COLORS.red });

    const scoreB = resB?.score ?? 0;
    const scoreR = resR?.score ?? 0;
    const roundWinner: KnTeam | "tie" =
      scoreB > scoreR ? "blue" : scoreR > scoreB ? "red" : "tie";
    const roundDiff = Math.abs(scoreB - scoreR);

    // Takım içi chat: bu turun reveal'i başlangıcından (phaseEndsAt − 15000)
    // sonraki mesajlar; roomCode'a takım son-eki ile Mavi/Kırmızı ayrı kanal.
    const REVEAL_PHASE_MS = 15000;
    const revealChatSince =
      state.phaseEndsAt != null
        ? new Date(state.phaseEndsAt - REVEAL_PHASE_MS).toISOString()
        : undefined;
    const teamChatCode = myTeam ? `${room.code}#${myTeam}` : room.code;

    const TeamColumn = ({ team }: { team: KnTeam }) => {
      const res = team === "blue" ? resB : resR;
      const det = round.detectives[team];
      const total = state.totals[team] ?? 0;
      const won = roundWinner === team;
      return (
        <div className={"kn-result-col kn-result-col--" + team + (won ? " is-winner" : "")}>
          <div className="kn-result-col__head">
            <span className="kn-result-col__team">{KN_TEAM_LABELS[team]}</span>
            {won && (
              <span className="kn-result-col__badge">
                <span aria-hidden>🏆</span> Tur Lideri
              </span>
            )}
          </div>
          <div className="kn-result-col__det">🕵️ {nameOf(det)}</div>
          <div className="kn-result-col__row">
            <span>Uzaklık</span>
            <strong>{formatDistanceKm(res?.distanceKm)}</strong>
          </div>
          <div className="kn-result-col__row">
            <span>Tur Puanı</span>
            <strong>{(res?.score ?? 0).toLocaleString("tr-TR")} <span className="kn-result-col__max">/ 5000</span></strong>
          </div>
          <div className="kn-result-col__row kn-result-col__row--total">
            <span>Toplam</span>
            <strong>{total.toLocaleString("tr-TR")}</strong>
          </div>
        </div>
      );
    };

    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-reveal-shell">
          <div className="kn-reveal kn-reveal--teams">
            <header className="kn-reveal__head kn-reveal__head--panel kn-anim-scale-in">
              <span className="kn-reveal__eyebrow">Tur {state.roundIndex + 1} · Tamamlandı</span>
              {roundWinner === "tie" ? (
                <h2 className="kn-reveal__title">Tur berabere</h2>
              ) : (
                <>
                  <h2 className="kn-reveal__title">
                    <span
                      className={"kn-reveal__winner-team kn-reveal__winner-team--" + roundWinner}
                    >
                      {KN_TEAM_LABELS[roundWinner]}
                    </span>{" "}
                    bu turu önde kapattı
                  </h2>
                  {roundDiff > 0 && (
                    <span className={"kn-reveal__diff kn-reveal__diff--" + roundWinner}>
                      Bu tur farkı +{roundDiff.toLocaleString("tr-TR")} puan
                    </span>
                  )}
                </>
              )}
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
                revealGuesses={revealGuesses}
                revealActual={actual}
                className="kn-reveal__map"
              />
            </div>

            <div className="kn-result-cols">
              <TeamColumn team="blue" />
              <div className="kn-result-mid">
                <span className="kn-result-mid__label">Gerçek Konum</span>
                {scene && <span className="kn-result-mid__place">{scene.regionLabel}</span>}
                <span className="kn-result-mid__vs">VS</span>
              </div>
              <TeamColumn team="red" />
            </div>

            {(guessB == null || guessR == null) && (
              <p className="kn-reveal__notice">
                {guessB == null && guessR == null
                  ? "İki dedektif de süresinde tahmin yapmadı."
                  : `${guessB == null ? KN_TEAM_LABELS.blue : KN_TEAM_LABELS.red} süresinde tahmin yapmadı (0 puan).`}
              </p>
            )}

            <div className="kn-reveal__actions">
              <p className="kn-reveal__waiting">
                {isLastRound ? "Final skorları" : "Sonraki tur"} birazdan…
              </p>
            </div>
          </div>

          <aside className="kn-reveal-chat">
            <LobbyChat
              key={`reveal-chat-${state.roundIndex}-${myTeam ?? "x"}`}
              roomCode={teamChatCode}
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

  /* ════════ FINAL RESULTS — kazanan takım + XP ════════ */
  if (state.phase === "final_results") {
    const blueTotal = state.totals.blue ?? 0;
    const redTotal = state.totals.red ?? 0;
    const winner: KnTeam | "tie" =
      blueTotal > redTotal ? "blue" : redTotal > blueTotal ? "red" : "tie";
    const myWon = winner !== "tie" && myTeam === winner;

    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className={"kn-center-wrap" + (xpView && !xpView.dismissed ? " kn-center-wrap--with-xp" : "")}>
          <div className="kn-card kn-final kn-anim-scale-in">
            <span className="kn-final__eyebrow">Dosya Kapandı</span>
            <h2 className="kn-card__title">
              {winner === "tie" ? "Berabere!" : `${KN_TEAM_LABELS[winner]} Kazandı`}
            </h2>

            {winner !== "tie" && (
              <div className="kn-final__winner">
                <span className="kn-final__crown" aria-hidden>🏆</span>
                <span className="kn-final__winner-label">Şampiyon</span>
                <span className={"kn-final__winner-name kn-final__winner-name--" + winner}>
                  {KN_TEAM_LABELS[winner]}
                  {myWon && " · senin takımın"}
                </span>
              </div>
            )}

            <div className="kn-final__teamscores">
              <div className={"kn-final__teamscore kn-final__teamscore--blue" + (winner === "blue" ? " is-winner" : "")}>
                <span className="kn-final__teamscore-label">🔵 {KN_TEAM_LABELS.blue}</span>
                <span className="kn-final__teamscore-value">{blueTotal.toLocaleString("tr-TR")}</span>
              </div>
              <div className={"kn-final__teamscore kn-final__teamscore--red" + (winner === "red" ? " is-winner" : "")}>
                <span className="kn-final__teamscore-label">🔴 {KN_TEAM_LABELS.red}</span>
                <span className="kn-final__teamscore-value">{redTotal.toLocaleString("tr-TR")}</span>
              </div>
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

        {xpView && !xpView.dismissed && (
          <XpGainBar
            modeLabel="Kör Nokta"
            prevTotalXp={xpView.prevTotalXp}
            newTotalXp={xpView.totalXp}
            prevModeXp={xpView.prevModeXp}
            newModeXp={xpView.modeXp}
            xpEarned={xpView.xpEarned}
            awarded={xpView.awarded}
            breakdown={xpView.breakdown}
            onDismiss={() => setXpView(v => (v ? { ...v, dismissed: true } : v))}
          />
        )}
      </div>
    );
  }

  /* Beklenmeyen faz/rol kombinasyonu — nötr bekleme. */
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
