/**
 * KorNoktaGame — Kör Nokta TAKIM modu gameplay (game_state version 3).
 *
 * KorNoktaMode lobby'sinin altında, room.status 'playing'/'finished' iken
 * render edilir. Oyun durumu tevatur_rooms.game_state jsonb blob'undan okunur
 * ve mevcut realtime UPDATE aboneliğiyle akar — bu bileşen kendi kanalını
 * AÇMAZ, room prop'u değiştikçe yeniden render olur.
 *
 * Takım modeli: iki takım (Mavi/Kırmızı) aynı sahneyle oynar. Her turda her
 * takımda 1 dedektif rotasyonla döner; dedektif sahneyi görmez. Yeni soru-cevap
 * akışı:
 *   1) observe_report — herkes sahneyi inceler; dedektif havuzdan ≤5 soru seçer.
 *   2) answer_questions — raporcular/casuslar hedef dedektifin sorularını
 *      Evet/Hayır/Emin değilim ile cevaplar (birbirini görmez).
 *   3) detective_guess — dedektif anonim cevap kartlarına göre haritada tahmin yapar.
 * Casus (iç değer "mole"; yalnız 3v3+) KARŞI takım dedektifinin sorularını
 * cevaplar; cevabı yalnız o dedektifin tahmin ekranında anonim görünür. Puanlama
 * mesafe bazlı 0–5000 (takım başına); finalde toplamı yüksek takım kazanır.
 *
 * Yetki: faz ilerletme SUNUCU-otoriter. Süre dolunca odanın her üyesi
 * `tevatur_kn_advance_if_due`yu çağırabilir; sunucu kilitli oda satırından
 * okuduğu phaseEndsAt'ı kendi saatiyle doğrular ve expected-round/phase CAS'ı
 * ile geçişin tam bir kez olmasını garanti eder (bkz. 20260813120000). Host-only
 * `advance_phase` MANUEL/erken geçiş içindir ve bu bileşenden ÇAĞRILMAZ.
 * Soru-seçimi/cevap/tahmin yazmaları yalnız ilgili oyuncunun RPC'siyle olur.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { supabase, type TevaturRoom, type TevaturPlayer } from "../../lib/supabase";
import { getSyncedNowMs, initServerClockSync } from "../../lib/serverClock";
import { playSound, stopSound, getCountdownSoundMode } from "../../lib/sound";
import {
  KN_TEAM_LABELS,
  findKnScene,
  getKnAnswerTargetTeam,
  getKnPlayerAnswers,
  getKnQuestionCandidates,
  getKnRole,
  getKnSelectedQuestions,
  getKnTeam,
  knReportLetter,
  parseKnGameState,
  type KnGameState,
  type KnPhase,
  type KnTeam,
  type KnTeamRound,
} from "./korNoktaGameTypes";
import {
  KN_ANSWER_GLYPHS,
  KN_ANSWER_LABELS,
  KN_ANSWER_VALUES,
  KN_QUESTION_PICK_COUNT,
  knQuestionText,
  type KnAnswerValue,
} from "./korNoktaQuestions";
import { resolveKnBackground } from "./korNoktaBackgrounds";
import { fetchKorNoktaRoomState } from "./korNoktaRoomState";
import { prefetchAssetUrl } from "../../lib/assetUrl";
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
import { markGuestMatchId, isGuestMatchId } from "../../lib/guestSession";
import GuestEndPrompt from "../../components/GuestEndPrompt";
import "./KorNoktaGame.css";

/** Takım renkleri — harita marker'ları ve panellerde kullanılır. */
const TEAM_COLORS: Record<KnTeam, string> = {
  blue: "#4f8bff",
  red:  "#ef4444",
};

/* ── Deadline watchdog gecikmeleri ──────────────────────────────────────────
 * Süre dolduğunda ilerletmeyi kimin TETİKLEDİĞİ önemli değildir (sunucu her
 * hâlükârda doğrular), ama normal durumda gereksiz RPC uçmasın diye host
 * birincil tetikleyicidir; diğer üyeler yalnız host yanıt vermezse devreye
 * girer. Host arka planda/kopukken maçı kurtaran şey bu ikinci penceredir.
 * Rota Düello'daki `amHost ? WAIT : WAIT + FALLBACK` deseniyle aynı. */
const ADVANCE_GRACE_HOST_MS  = 600;
const ADVANCE_GRACE_OTHER_MS = 2_500;

/* ── Supabase RPC hata şekli (PostgrestError: code/message/details/hint) ── */
type KnRpcError =
  | { code?: string; message?: string; details?: string | null; hint?: string | null }
  | null
  | undefined;

/**
 * RPC hatasını konsola AÇIKÇA döker — code/message/details/hint + gönderilen
 * payload. Canlı testte gerçek sebebi görmek için tek kaynak (jenerik toast
 * artık tek başına yeterli değil).
 */
function logKnRpcError(label: string, error: KnRpcError, payload?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[KorNokta] ${label} RPC failed`, {
    code:    error?.code,
    message: error?.message,
    details: error?.details ?? null,
    hint:    error?.hint ?? null,
    payload,
  });
}

/* ── RPC hata etiketleri → kullanıcı dostu Türkçe ── */
function describeKnGameError(error: KnRpcError): string | null {
  if (!error) return null;
  const msg  = (error.message ?? "").toLowerCase();
  const code = (error.code ?? "").toUpperCase();

  // Fonksiyon/şema bulunamadı → migration canlıya uygulanmamış olabilir.
  // PostgREST: PGRST202 (şema cache'inde yok), Postgres: 42883 (undefined_function).
  if (
    code === "PGRST202" ||
    code === "42883" ||
    msg.includes("could not find the function") ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  ) {
    return "Kör Nokta veritabanı güncel değil (migration eksik olabilir). Yöneticiye bildir.";
  }

  if (msg.includes("questions_invalid")) return "Soru seçimi geçersiz. Tekrar dene.";
  if (msg.includes("question_invalid"))  return "Bu soru artık geçerli değil.";
  if (msg.includes("answer_invalid"))    return "Cevap geçersiz.";
  if (msg.includes("already_submitted")) return "Bu tur için zaten gönderdin.";
  if (msg.includes("wrong_phase"))       return "Bu aşama kapandı.";
  if (msg.includes("not_reporter"))      return "Bu turda cevap veremezsin.";
  if (msg.includes("not_detective"))     return "Bu turda dedektif değilsin.";
  if (msg.includes("guess_required"))    return "Önce haritaya pin koymalısın.";
  if (msg.includes("game_not_active"))   return "Oyun aktif değil.";
  if (msg.includes("room_not_found"))    return "Oda bulunamadı. Sayfayı yenile.";
  if (msg.includes("unauthorized"))
    return "Yetki hatası. Sayfayı yenileyip tekrar dene.";
  return null;
}

/**
 * Toast metni: bilinen hata → Türkçe; bilinmeyen → temel mesaj. Geliştirme
 * modunda (import.meta.env.DEV) ham code/message eklenir ki canlı-olmayan
 * testte sebep ekranda da görünsün; production'da kısa kalır.
 */
function knActionErrorText(error: KnRpcError, base: string): string {
  const known = describeKnGameError(error);
  if (known) return known;
  if (import.meta.env.DEV && error) {
    const detail = [error.code, error.message].filter(Boolean).join(": ");
    return detail ? `${base} (${detail})` : base;
  }
  return base;
}

const PHASE_LABELS: Record<KnPhase, string> = {
  role_reveal:      "Roller",
  observe_report:   "İnceleme",
  answer_questions: "Cevaplama",
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
  /** Sonuç ekranı "Lobiye Dön" — odadan AYRILMADAN yerel görünümü lobiye
   *  çevirir (Kuşatma pattern'i). Bu bileşen unmount olunca timer/interval/
   *  submit listener/sonuç overlay temizlenir. */
  onReturnToLobby: () => void;
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
  onReturnToLobby,
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

  /* ── Deadline watchdog: "süre dolduysa ilerlet" ──
   *
   * ÖNCEDEN: yalnız host bir setInterval'de `advance_phase` çağırırdı ve sunucu
   * phaseEndsAt'a HİÇ bakmazdı. Host telefonu kilitlediğinde / uygulamayı arka
   * plana attığında JS timer'ları donduğu için o çağrı hiç gitmez ve maç DİĞER
   * ÜÇ OYUNCU İÇİN DE takılırdı — tek arıza noktası.
   *
   * ŞİMDİ: odanın her üyesi (kayıtlı + misafir) `advance_if_due` çağırabilir.
   * Yetki genişlemesi DEĞİLDİR: sunucu kilitli oda satırından okuduğu
   * phaseEndsAt'ı kendi saatiyle doğrular, süre dolmadıysa hiçbir şey yapmaz;
   * dolduysa da yalnız zaten yapacağı geçişi yapar. Erken atlama imkânsız.
   *
   * Host'un kendi yolu da buraya taşındı: böylece saati ileri kaymış bir host
   * artık fazı herkes için erken kesemez (sunucu reddeder, watchdog 500 ms'de
   * bir yeniden dener ve gerçek deadline'da geçer).
   */
  const advanceInFlightRef = useRef(false);
  const advanceIfDue = useCallback(
    async (expectedRound: number, expectedPhase: KnPhase) => {
      if (advanceInFlightRef.current) return;
      advanceInFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("tevatur_kn_advance_if_due", {
          p_room_id:        room.id,
          p_player_id:      myId,
          p_claim_token:    claimToken,
          p_expected_round: expectedRound,
          p_expected_phase: expectedPhase,
        });
        if (error) {
          console.error("[KorNokta] advance_if_due RPC failed", error);
        } else if (data?.id) {
          // Süre dolmadıysa / yarışı kaybettiysek de TAZE oda döner (sunucu
          // hata değil, değişmemiş satır verir) → bayat istemci kendini onarır.
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
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    const graceMs = isHost ? ADVANCE_GRACE_HOST_MS : ADVANCE_GRACE_OTHER_MS;

    const check = () => {
      if (getSyncedNowMs() >= phaseEndsAt + graceMs) {
        void advanceIfDue(roundIndex, phase);
      }
    };

    // Mount / reconnect / her faz değişimi: interval'in ilk tick'ini bekleme.
    // Uzun süre arka planda kalıp geri dönen istemci deadline'ı ANINDA görür.
    check();
    const id = window.setInterval(check, 500);

    // Uyanma tetikleyicileri: arka plandan dönen sekmede timer'lar kısılmış
    // ya da tamamen durmuş olabilir; bu üç olay watchdog'u hemen çalıştırır.
    const onVisibility = () => { if (document.visibilityState !== "hidden") check(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, [isHost, phase, roundIndex, phaseEndsAt, advanceIfDue]);

  /* ── Sonraki turun 360 sahnesini düşük öncelikle ön-yükle: native'de remote
   *    URL'in HTTP cache'ini ısıtır; web'de same-origin → pratikte zararsız.
   *    Best-effort (hata yutulur); yalnız aktif sahne lazy yüklenir. ── */
  const nextSceneId = state?.scenes?.[roundIndex + 1]?.id ?? null;
  useEffect(() => {
    if (!nextSceneId) return;
    const next = findKnScene(nextSceneId);
    if (next?.imagePath) prefetchAssetUrl(next.imagePath);
  }, [nextSceneId]);

  /* ── Watchdog: realtime event kaçarsa stale kalmayalım ── */
  useEffect(() => {
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    const id = window.setInterval(() => {
      if (getSyncedNowMs() < phaseEndsAt + 3000) return;
      // Ham `tevatur_rooms` okuması YOK: misafirde o yol kapalı
      // (20260811120000). Tek okuma yolu üyeliği doğrulayan RPC'dir.
      void fetchKorNoktaRoomState(room.id, myId, claimToken).then(result => {
        if (result.status === "ok") onRoomUpdateRef.current?.(result.room);
      });
    }, 5000);
    return () => window.clearInterval(id);
  }, [phase, roundIndex, phaseEndsAt, room.id, myId, claimToken]);

  /* ── Süreli fazların son saniyelerinde geri sayım sesi ── */
  const countdownPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!phase || phase === "final_results" || phaseEndsAt == null) return;
    if (getCountdownSoundMode() === "off") return;
    const remaining = Math.max(0, Math.ceil((phaseEndsAt - getSyncedNowMs()) / 1000));
    const countdownThreshold =
      phase === "observe_report" || phase === "answer_questions" ? 10 : 5;
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

  /* ── inceleme/cevaplama ambient müziği (yalnız bu client) ── */
  useEffect(() => {
    const remaining =
      phaseEndsAt == null
        ? null
        : Math.max(0, Math.ceil((phaseEndsAt - getSyncedNowMs()) / 1000));
    const ambientOn =
      (phase === "observe_report" || phase === "answer_questions") &&
      remaining != null &&
      remaining > 8;
    if (ambientOn) {
      playSound("korNoktaReportAmbient");
    } else {
      stopSound("korNoktaReportAmbient");
    }
  }, [phase, roundIndex, phaseEndsAt, nowMs]);

  useEffect(() => {
    return () => stopSound("korNoktaReportAmbient");
  }, []);

  /* ── Tur-lokal form state'leri (tur değişince sıfırlanır) ──
   * picked/answers null iken render server state'ini gösterir (refresh/reconnect
   * geri yükler); ilk kullanıcı aksiyonundan sonra local önde gider. */
  const [pickedLocal, setPickedLocal]       = useState<string[] | null>(null);
  const [answersLocal, setAnswersLocal]     = useState<Record<string, KnAnswerValue> | null>(null);
  const [guess, setGuess]                   = useState<KnLatLng | null>(null);
  const [actionError, setActionError]       = useState<string | null>(null);
  const [guessError, setGuessError]         = useState<string | null>(null);
  const [guessSubmitting, setGuessSubmitting] = useState(false);
  /* ── Canlı konum tahmini gönderici (latest-write-wins) ──
   * Faz açıkken dedektif haritaya istediği kadar tıklar; her tıklama aday
   * koordinatı günceller (harita/marker KİLİTLENMEZ). Aynı anda tek RPC uçar;
   * uçuş biterken daha yeni bir konum kuyruğa girdiyse o gönderilir → hızlı
   * tıklamada yalnız son konum server'a yazılır. Her gönderim monotonik `seq`
   * taşır; server eski/geç geleni ezmez. Faz kapanınca kuyruk durur. */
  const guessSeqRef                         = useRef(0);
  const pendingGuessRef                     = useRef<{ lat: number; lng: number; seq: number } | null>(null);
  const guessInFlightRef                    = useRef(false);
  const guessPhaseActiveRef                 = useRef(false);

  useEffect(() => {
    setPickedLocal(null);
    setAnswersLocal(null);
    setActionError(null);
    setGuess(null);
    setGuessError(null);
    setGuessSubmitting(false);
    guessSeqRef.current = 0;
    pendingGuessRef.current = null;
    guessInFlightRef.current = false;
  }, [roundIndex]);

  /* Konum tahmini yazımı yalnız detective_guess açıkken serbest. Faz değişince
   * (süre doldu → round_reveal) bekleyen gönderim durdurulur; server deadline
   * otoriter kalır (geç istek zaten reddedilir). */
  useEffect(() => {
    const active = phase === "detective_guess";
    guessPhaseActiveRef.current = active;
    if (!active) pendingGuessRef.current = null;
  }, [phase]);

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
    if (!myTeamForXp) return;

    // ── MİSAFİR / XP SINIRI (maç bazlı) ──────────────────────────────────
    // Misafirken biten maç, o maçın kimliğiyle (room.id) işaretlenir. Oyuncu
    // sonuç ekranındaki "Hesap Oluştur"dan kayıt olsa bile GEÇMİŞ maça XP
    // yazılmaz — hesap açılınca profile dolar, bu effect yeniden koşar ve
    // işaret onu durdurur. YENİ tur farklı bir maç kimliği taşıdığı için
    // normal şekilde XP kazandırır. (Diğer beş modla aynı desen.)
    if (!myProfileId) {
      markGuestMatchId(room.id);
      return;
    }
    if (isGuestMatchId(room.id)) return;

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

  /* ── Soru-cevap türetilmiş değerler ── */
  // Bu turun 20 aday sorusu (server üretti; iki takım da aynı listeyi görür).
  const candidateQuestions = getKnQuestionCandidates(round);

  // Dedektif: bu turda kendi takımının seçtiği sorular (local-or-server).
  const serverPicked = myTeam ? getKnSelectedQuestions(round, myTeam) : [];
  const picked = pickedLocal ?? serverPicked;

  // Cevaplayıcı: hangi dedektife düştüğü + o dedektifin soruları + verdiği cevaplar.
  const myAnswerTarget = getKnAnswerTargetTeam(round, myId);
  const targetQuestions = myAnswerTarget ? getKnSelectedQuestions(round, myAnswerTarget) : [];
  const serverAnswers = getKnPlayerAnswers(round, myId);
  const answers = answersLocal ?? serverAnswers;
  const answeredCount = targetQuestions.filter(qid => !!answers[qid]).length;

  // Dedektif tahmin ekranı: kendi seçtiği sorular + göreceği anonim cevaplayıcılar.
  const mySelected = myTeam ? getKnSelectedQuestions(round, myTeam) : [];
  const myReportOrder = myTeam ? round.reportOrder[myTeam] : [];

  /* ── Aksiyonlar ── */
  // Dedektif soru seçimi: tam listeyi gönderir (overwrite); local optimistik.
  function selectQuestions(ids: string[]) {
    setPickedLocal(ids);
    setActionError(null);
    (async () => {
      const { data, error } = await supabase.rpc("tevatur_kn_select_questions", {
        p_room_id:      room.id,
        p_player_id:    myId,
        p_claim_token:  claimToken,
        p_question_ids: ids,
      });
      if (error) {
        logKnRpcError("select_questions", error, {
          ids,
          count: ids.length,
          roundIndex,
          candidateCount: candidateQuestions.length,
        });
        setActionError(
          knActionErrorText(error, "Soru seçimin kaydedilemedi. Tekrar dene."),
        );
        return;
      }
      if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
    })();
  }

  function toggleQuestion(qid: string) {
    const on = picked.includes(qid);
    if (!on && picked.length >= KN_QUESTION_PICK_COUNT) return; // 5'ten fazla yok
    playSound("click");
    selectQuestions(on ? picked.filter(id => id !== qid) : [...picked, qid]);
  }

  // Raporcu/casus cevabı: tek soru gönderir (merge); local optimistik.
  function submitAnswer(qid: string, value: KnAnswerValue) {
    if (answers[qid] === value) return;
    playSound("click");
    const next = { ...answers, [qid]: value };
    setAnswersLocal(next);
    setActionError(null);
    (async () => {
      const { data, error } = await supabase.rpc("tevatur_kn_submit_answer", {
        p_room_id:     room.id,
        p_player_id:   myId,
        p_claim_token: claimToken,
        p_question_id: qid,
        p_answer:      value,
      });
      if (error) {
        logKnRpcError("submit_answer", error, { qid, value });
        setActionError(
          knActionErrorText(error, "Cevabın kaydedilemedi. Tekrar dene."),
        );
        return;
      }
      if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
    })();
  }

  /**
   * Monotonik seq: oturum içinde kesin artan; reconnect'te de büyür (Date.now()
   * tabanı). Server bunu latest-write-wins için kullanır — küçük/eşit seq'li
   * (ağdan geç gelen) istek kayıtlı konumu EZEMEZ.
   */
  function nextGuessSeq(): number {
    guessSeqRef.current = Math.max(guessSeqRef.current + 1, Date.now());
    return guessSeqRef.current;
  }

  /**
   * Harita her tıklamasında çağrılır. Marker/harita KİLİTLENMEZ: en güncel
   * konumu kuyruğa (pendingGuessRef) koyar ve göndericiyi tetikler. Süre bitene
   * kadar dilediğin kadar çağrılabilir; final seçim yoktur — son gönderilen kalır.
   */
  function queueGuess(g: KnLatLng) {
    setGuess(g);
    setGuessError(null);
    pendingGuessRef.current = { lat: g.lat, lng: g.lng, seq: nextGuessSeq() };
    playSound("click");
    void flushGuess();
  }

  /**
   * Latest-write-wins gönderici. Aynı anda tek RPC tutar (guessInFlightRef);
   * uçuş biterken daha yeni konum kuyruğa girdiyse onu da gönderir → hızlı
   * tıklamada yalnız SON konum server'a yazılır. Faz/deadline'a DOKUNMAZ: yalnız
   * game_state.guesses[team] güncellenir (skor + faz geçişi süre dolunca
   * advance_if_due → apply_round ile TEK KEZ olur — burada değil).
   *
   * Hata:
   *   • deadline geçti / faz kapandı → server otoriter; kuyruk durur, sessiz.
   *   • geçici hata → daha yeni konum yoksa bunu geri koyup faz açıkken yeniden dener.
   */
  async function flushGuess() {
    if (guessInFlightRef.current) return;      // uçuş bitince kendisi yeniden flush eder
    if (!guessPhaseActiveRef.current) return;  // faz kapalı → yazma yok
    const next = pendingGuessRef.current;
    if (!next) return;
    pendingGuessRef.current = null;            // bu konumu sahiplen
    guessInFlightRef.current = true;
    setGuessSubmitting(true);
    const { data, error } = await supabase.rpc("tevatur_kn_submit_guess", {
      p_room_id:     room.id,
      p_player_id:   myId,
      p_claim_token: claimToken,
      p_lat:         next.lat,
      p_lng:         next.lng,
      p_seq:         next.seq,
    });
    guessInFlightRef.current = false;
    if (error) {
      logKnRpcError("submit_guess", error, { lat: next.lat, lng: next.lng, seq: next.seq });
      const msg = (error.message ?? "").toLowerCase();
      // Süre doldu / faz round_reveal'e geçti → server kesim otoritesi; dur.
      if (msg.includes("guess_deadline_passed") || msg.includes("wrong_phase")) {
        guessPhaseActiveRef.current = false;
        pendingGuessRef.current = null;
        setGuessSubmitting(false);
        return;
      }
      // Geçici hata → daha yeni tık kuyruğa girmediyse bunu geri koy, faz
      // açıkken kısa süre sonra en güncel konumu tekrar dene (skorsuz kalmasın).
      if (!pendingGuessRef.current) pendingGuessRef.current = next;
      setGuessSubmitting(false);
      setGuessError(knActionErrorText(error, "Konum kaydedilemedi. Tekrar deneniyor…"));
      if (guessPhaseActiveRef.current) window.setTimeout(() => void flushGuess(), 600);
      return;
    }
    if (data?.id) onRoomUpdateRef.current?.(data as TevaturRoom);
    setGuessSubmitting(false);
    setGuessError(null); // başarı → önceki geçici hata banner'ını temizle
    // Uçuş sırasında yeni tık geldiyse onu da gönder (yalnız son konum yazılır).
    if (pendingGuessRef.current) void flushGuess();
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
      {myRole === "mole" && <span className="kn-chip kn-chip--mole">🎭 Casus</span>}
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
                Fotoğrafı görmeyeceksin. Önce 5 soru seç; sonra gelen anonim
                cevaplara göre konumu bul.
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
                Sahneyi incele. Dedektifinin seçtiği sorulara dürüst cevap ver;
                onu doğru yere yönlendir.
              </p>
            </div>
          )}
          {myRole === "mole" && (
            <div className="kn-rolecard kn-rolecard--mole kn-anim-scale-in">
              <span className="kn-rolecard__eyebrow">Gizli Talimat</span>
              <span className="kn-rolecard__emoji" aria-hidden>🎭</span>
              <h2 className="kn-rolecard__title">Casussun</h2>
              <span className="kn-rolecard__rule" aria-hidden />
              <p className="kn-rolecard__desc">
                Cevapların KARŞI takımın dedektifine gidecek. Onu yanılt — ama
                belli etme.
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

  /* ════════ OBSERVE — dedektif: soru seçimi ════════ */
  if (state.phase === "observe_report" && myRole === "detective") {
    return (
      <div {...knScreen("kn-screen--qselect")}>
        {topbar}
        <div className="kn-qselect">
          <header className="kn-qselect__head kn-anim-scale-in">
            <span className="kn-qselect__eyebrow">İnceleme · Soru Seçimi</span>
            <h2 className="kn-qselect__title">5 Soru Seç</h2>
            <p className="kn-qselect__sub">
              {candidateQuestions.length} sorudan en fazla {KN_QUESTION_PICK_COUNT}
              {" "}tanesini seç. Süre dolunca seçimin kilitlenir; eksik kalırsa
              otomatik tamamlanır.
            </p>
            <span
              className={
                "kn-qselect__counter" +
                (picked.length >= KN_QUESTION_PICK_COUNT ? " is-full" : "")
              }
            >
              {picked.length}/{KN_QUESTION_PICK_COUNT} soru seçildi
            </span>
            {actionError && <p className="kn-error">{actionError}</p>}
            {candidateQuestions.length === 0 && (
              <p className="kn-error">
                Bu tur için aday sorular yüklenemedi. Oda eski sürümle açılmış veya
                veritabanı güncel olmayabilir.
              </p>
            )}
          </header>

          <div className="kn-qgrid">
            {candidateQuestions.map(qid => {
              const on = picked.includes(qid);
              const disabled = !on && picked.length >= KN_QUESTION_PICK_COUNT;
              return (
                <button
                  key={qid}
                  type="button"
                  className={
                    "kn-qcard" + (on ? " is-on" : "") + (disabled ? " is-disabled" : "")
                  }
                  onClick={() => toggleQuestion(qid)}
                  disabled={disabled}
                  aria-pressed={on}
                >
                  <span className="kn-qcard__check" aria-hidden>{on ? "✓" : "+"}</span>
                  <span className="kn-qcard__text">{knQuestionText(qid)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  /* ════════ OBSERVE — raporcu/casus: sahneyi incele (henüz cevap yok) ════════ */
  if (
    state.phase === "observe_report" &&
    (myRole === "reporter" || myRole === "mole")
  ) {
    return (
      <div {...knScreen("kn-screen--stage")}>
        <Panorama360
          src={scene?.imagePath ?? ""}
          className="kn-stage-pano"
          attribution={scene?.attribution}
          mirrorX={scene?.sourceType === "real_world"}
        />
        <div className="kn-stage-top">{topbar}</div>
        <div className={"kn-reportbar kn-anim-fade-up" + (myRole === "mole" ? " kn-reportbar--mole" : "")}>
          <div className="kn-reportbar__head">
            <span className="kn-mission__eyebrow">
              {myRole === "mole" ? "Gizli Görev" : "Sahneyi İncele"}
            </span>
            <span className="kn-reportbar__category">
              Dedektif soruları seçiyor…
            </span>
            <span className="kn-reportbar__hint">
              {myRole === "mole"
                ? "İyi bak. Birazdan KARŞI takım dedektifinin soruları gelecek — onu yanıltacaksın."
                : "İyi bak. Birazdan dedektifinin seçtiği sorular gelecek ve cevaplayacaksın."}
            </span>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ OBSERVE — gözlemci bekleme ════════ */
  if (state.phase === "observe_report") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-briefing kn-anim-scale-in">
            <div className="kn-radar" aria-hidden />
            <span className="kn-briefing__eyebrow">İnceleme</span>
            <h2 className="kn-briefing__title">Tur Hazırlanıyor</h2>
            <p className="kn-briefing__desc">
              Dedektifler sorularını seçiyor. Birazdan cevaplar toplanacak.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ ANSWER — raporcu/casus: soruları cevapla ════════ */
  if (
    state.phase === "answer_questions" &&
    (myRole === "reporter" || myRole === "mole")
  ) {
    return (
      <div {...knScreen("kn-screen--stage")}>
        <Panorama360
          src={scene?.imagePath ?? ""}
          className="kn-stage-pano"
          attribution={scene?.attribution}
          mirrorX={scene?.sourceType === "real_world"}
        />
        <div className="kn-stage-top">{topbar}</div>

        <div className={"kn-answersheet kn-anim-fade-up" + (myRole === "mole" ? " kn-answersheet--mole" : "")}>
          <header className="kn-answersheet__head">
            <span className="kn-mission__eyebrow">
              {myRole === "mole" ? "Gizli Görev" : "Cevapla"}
            </span>
            <span className="kn-answersheet__note">
              {myRole === "mole"
                ? "Casus: cevapların rakip dedektife gidecek. Onu yanıltmaya çalış."
                : "Raporcu: dedektifine doğru ipucu ver."}
            </span>
            <span className="kn-answersheet__sub">
              Cevapların dedektife anonim gönderilecek · {answeredCount}/{targetQuestions.length}
            </span>
          </header>

          {targetQuestions.length === 0 ? (
            <p className="kn-answersheet__empty">Soru bekleniyor…</p>
          ) : (
            <div className="kn-qanswer-list">
              {targetQuestions.map((qid, i) => (
                <div className="kn-qanswer" key={qid}>
                  <div className="kn-qanswer__q">
                    <span className="kn-qanswer__num">{i + 1}</span>
                    {knQuestionText(qid)}
                  </div>
                  <div className="kn-qanswer__opts">
                    {KN_ANSWER_VALUES.map(v => (
                      <button
                        key={v}
                        type="button"
                        className={
                          "kn-ans-btn kn-ans-btn--" + v + (answers[qid] === v ? " is-on" : "")
                        }
                        onClick={() => submitAnswer(qid, v)}
                        aria-pressed={answers[qid] === v}
                      >
                        {KN_ANSWER_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {actionError && <p className="kn-error">{actionError}</p>}
        </div>
      </div>
    );
  }

  /* ════════ ANSWER — dedektif: seçtiği soruları görür, cevapları bekler ════════ */
  if (state.phase === "answer_questions" && myRole === "detective") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-briefing kn-briefing--wide kn-anim-scale-in">
            <div className="kn-radar" aria-hidden />
            <span className="kn-briefing__eyebrow">İstihbarat Bekleniyor</span>
            <h2 className="kn-briefing__title">Cevaplar Toplanıyor</h2>
            <p className="kn-briefing__desc">
              Seçtiğin sorular tanıklara gönderildi. Anonim cevaplar birazdan önüne düşecek.
            </p>
            <ul className="kn-briefing__qlist">
              {mySelected.map((qid, i) => (
                <li key={qid}>
                  <span className="kn-qanswer__num">{i + 1}</span>
                  {knQuestionText(qid)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ ANSWER — gözlemci bekleme ════════ */
  if (state.phase === "answer_questions") {
    return (
      <div {...knScreen("kn-cine")}>
        {topbar}
        <div className="kn-center-wrap">
          <div className="kn-briefing kn-anim-scale-in">
            <div className="kn-radar" aria-hidden />
            <span className="kn-briefing__eyebrow">Cevaplama</span>
            <h2 className="kn-briefing__title">Tanıklar Cevaplıyor</h2>
            <p className="kn-briefing__desc">
              Raporcular dedektiflerin sorularını cevaplıyor.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ════════ GUESS — dedektif: anonim cevaplar + harita tahmini ════════ */
  if (state.phase === "detective_guess" && myRole === "detective") {
    // İlk pin sonrası harita AÇIK ve etkileşimli kalır (kilit/overlay yok).
    // Oyuncu süre bitene kadar dilediği kadar farklı noktaya tıklayabilir;
    // son gönderilen konum server'da nihai tahmin sayılır.
    return (
      <div {...knScreen()}>
        {topbar}
        <div className="kn-guess">
          <div className="kn-guess__reports">
            <header className="kn-guess__head">
              <span className="kn-guess__eyebrow">Dosya Hazır</span>
              <h2 className="kn-guess__title">Anonim Cevaplar</h2>
              {/* Mobilde ilk iki cümle GİZLENİR (kn-guess__sub-long): ikisi de
                  haritanın altındaki canlı ipucunda + kontrol listesinde zaten
                  yazıyor, dar ekranda 4 satır yer yiyordu. Anonimlik cümlesi
                  başka hiçbir yerde geçmediği için her ekranda kalır. */}
              <p className="kn-guess__sub">
                <span className="kn-guess__sub-long">
                  Tanıkların cevaplarını incele ve konumu işaretle. Haritaya her
                  dokunuşta tahminin anında kaydedilir; süre bitene kadar dilediğin
                  kadar değiştirebilirsin.{" "}
                </span>
                Hangi cevabın kimden geldiği gizlidir.
              </p>
            </header>

            {/* Masaüstünde `display: contents` → DOM akışı ve yerleşim birebir
                aynı kalır. Mobilde yatay snap şeridine dönüşür, böylece her
                tanık kartı tam görünür ve harita dikey alanı geri kazanır. */}
            <div className="kn-guess__cards">
            {myReportOrder.map((pid, i) => {
              const ans = getKnPlayerAnswers(round, pid);
              return (
                <article
                  key={pid}
                  className="kn-answer-card kn-anim-fade-up"
                  style={{ "--kn-delay": `${i * 0.06}s` } as CSSProperties}
                >
                  <div className="kn-answer-card__meta">Cevap {knReportLetter(i)}</div>
                  <ul className="kn-answer-card__rows">
                    {mySelected.map((qid, qi) => {
                      const v = ans[qid];
                      return (
                        <li key={qid} className="kn-answer-card__row">
                          <span className="kn-answer-card__q">
                            <span className="kn-qanswer__num">{qi + 1}</span>
                            {knQuestionText(qid)}
                          </span>
                          <span
                            className={
                              "kn-answer-pill " +
                              (v ? "kn-answer-pill--" + v : "kn-answer-pill--none")
                            }
                          >
                            {v ? KN_ANSWER_GLYPHS[v] : "—"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              );
            })}
            </div>

            <div className="kn-guess__checklist">
              <span className={guess ? "is-done" : ""}>
                {guess ? "✅ Konum işaretlendi" : "📍 Haritaya pin koy"}
              </span>
            </div>
          </div>

          <div className="kn-guess__map-panel">
            <KorNoktaGuessMap
              key={`pick-${state.roundIndex}`}
              mode="pick"
              onGuessChange={queueGuess}
              className="kn-guess__map"
            />
            <p className="kn-guess__livehint">
              {guess
                ? "Tahminini süre bitene kadar değiştirebilirsin. Süre dolduğunda son konum sayılır."
                : "Haritaya dokunarak konumu işaretle."}
              {guessSubmitting && guess ? " · kaydediliyor…" : ""}
            </p>
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

            <div className="kn-final__actions">
              <button
                type="button"
                className="btn btn-accent kn-wide-btn"
                onClick={() => {
                  playSound("click");
                  onReturnToLobby();
                }}
              >
                ← Lobiye Dön
              </button>
              <button
                type="button"
                className="btn btn-ghost kn-wide-btn"
                onClick={() => {
                  playSound("click");
                  onExit();
                }}
              >
                Ana Menüye Dön
              </button>
            </div>

            {/* Misafir oyun-sonu: hesap oluştur / giriş yap. Sonuç kartının
                mevcut "Lobiye Dön" + "Ana Menüye Dön" butonlarını TEKRAR
                ETMEZ; onların yanında durur. Metin geçmiş maçın XP'sini VAAT
                ETMEZ — kazanç bir sonraki turdan itibaren başlar. */}
            <GuestEndPrompt visible={!myProfileId} />
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
