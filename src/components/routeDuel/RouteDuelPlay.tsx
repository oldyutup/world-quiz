/**
 * RouteDuelPlay.tsx — Rota Duel oyun ekranı (presentational + lokal giriş).
 *
 * Offline Rota Modu'nun harita görünümü ve etkileşimi AYNEN yeniden
 * kullanılır: RouteMapView + .route-* sınıfları + yazılı komşu-ülke girişi.
 * Üstüne online HUD gelir: Tur x/y (uzatmada "UZATMA"), başlangıç→hedef,
 * Ben/Rakip skoru, rakip bağlantı durumu.
 *
 * SÜRE SINIRI YOKTUR (2026-08-21 ürün kararı, 20260822120000 ile sunucuda da).
 * Oyunun amacı "hedefe rakipten önce ulaşmak"; hız zaten doğal olarak
 * belirleyici. Geri sayım ne GÖSTERİLİR ne de bir kurala bağlıdır: geçen süre
 * turu bitiremez, maçı bitiremez, hamleyi reddettiremez. `room.round_deadline`
 * bu dosyada HİÇ OKUNMAZ (kolon yalnız eski istemci uyumu için duruyor).
 * Tur YALNIZ biri hedefe ulaşınca biter.
 *
 * Optimistic UI + sunucu-otoriter uzlaşma:
 *   • Geçerli görünen hamle lokal path'e ANINDA eklenir (hız hissi).
 *   • route_duel_submit_move sunucuda konum+komşuluğu yeniden doğrular;
 *     reddederse (round_over/not_neighbor/...) lokal path sunucu satırına
 *     GERİ SARILIR — puan/tur/kazanan asla client'ta yazılmaz.
 *   • Tur kimliği (game_seq:current_round) değişince lokal path sıfırlanır.
 *
 * KOMPAKT HUD (telefon): `compact` true iken geri düğmesi HUD'un İÇİNDE, ilk
 * öğe olarak çizilir ve üstteki ayrı .duel-header hiç mount edilmez (bkz.
 * RouteDuelGame). Tek şerit: [←] [Tur x/y] [BAŞLANGIÇ → HEDEF] [ad s–s ad].
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RouteMapView } from "../WorldMap";
import { playSound } from "../../lib/sound";
import { getSyncedNowMs } from "../../lib/serverClock";
import {
  NORM_TO_ROUTE_KEY,
  getNeighbors,
  routeKeyToDisplay,
  normalizeInput,
} from "../../data/countries";
import {
  isOvertimeRound,
  type RouteDuelRoom,
  type RouteDuelPlayer,
} from "../../lib/routeDuelShared";
import {
  deriveOppConnectionView,
  isServerConfirmedDisconnect,
  parseServerTimestampMs,
} from "../../lib/routeDuelConnection";

export interface RouteDuelMoveResult {
  accepted: boolean;
  finished: boolean;
  won: boolean;
  reason?: string;
}

interface Props {
  room: RouteDuelRoom;
  me: RouteDuelPlayer | undefined;
  opp: RouteDuelPlayer | undefined;
  keyToTopoId: Record<string, string>;
  /** Rakibin son görülme yaşı (sn) — HUD bağlantı durumu. null = bilinmiyor. */
  oppStaleSeconds: number | null;
  onSubmitMove: (countryKey: string) => Promise<RouteDuelMoveResult>;
  /** Telefon: geri düğmesi HUD'un içine iner, ayrı .duel-header mount EDİLMEZ.
   *  Masaüstünde false → HUD ve header eskisi gibi ayrı kalır. */
  compact?: boolean;
  /** `compact` iken HUD içindeki geri düğmesinin eylemi (çıkış onayı açar). */
  onExit?: () => void;
}

export default function RouteDuelPlay({
  room,
  me,
  opp,
  keyToTopoId,
  oppStaleSeconds,
  onSubmitMove,
  compact = false,
  onExit,
}: Props) {
  const startKey = room.round_start_key ?? "";
  const targetKey = room.round_target_key ?? "";
  const roundKey = `${room.game_seq}:${room.current_round}`;

  /* ── Lokal (optimistic) path — tur kimliğine bağlı ── */
  const [localPath, setLocalPath] = useState<string[]>(() => (startKey ? [startKey] : []));
  const roundKeyRef = useRef(roundKey);
  useEffect(() => {
    if (roundKeyRef.current !== roundKey) {
      roundKeyRef.current = roundKey;
      setLocalPath(startKey ? [startKey] : []);
      setInput("");
      setErrMsg(null);
      setOkMsg(null);
    }
  }, [roundKey, startKey]);

  /* Sunucu path'i (realtime players UPDATE) daha uzunsa onu al — başka
     sekme/yeniden bağlanma senaryosunda sunucu her zaman kazanır. */
  const serverPath = me?.path ?? [];
  const displayPath = useMemo(() => {
    const base = localPath.length > 0 ? localPath : startKey ? [startKey] : [];
    if (serverPath.length > base.length && serverPath[0] === startKey) return serverPath;
    return base;
  }, [localPath, serverPath, startKey]);

  const currentKey = displayPath.length > 0 ? displayPath[displayPath.length - 1] : startKey;
  const stepsCount = Math.max(0, displayPath.length - 1);

  /* ── Giriş + geri bildirim ── */
  const [input, setInput] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const okTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittingRef = useRef(false);

  const showErr = useCallback((msg: string) => {
    if (errTimerRef.current) clearTimeout(errTimerRef.current);
    setErrMsg(msg);
    setOkMsg(null);
    errTimerRef.current = setTimeout(() => setErrMsg(null), 2500);
  }, []);

  const showOk = useCallback((msg: string) => {
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
    setOkMsg(msg);
    setErrMsg(null);
    okTimerRef.current = setTimeout(() => setOkMsg(null), 900);
  }, []);

  useEffect(() => () => {
    if (errTimerRef.current) clearTimeout(errTimerRef.current);
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
  }, []);

  /* ── Tur başlangıç senkronu (3 sn ortak geri sayım) ──
     SÜRE SINIRI DEĞİL: iki oyuncunun aynı anda başlamasını sağlar. Tik yalnız
     geri sayım penceresi açıkken atar; tur başlayınca interval SÖKÜLÜR. Eskiden
     200 ms'lik tik maç boyunca dönüyor ve saniyede 5 kez RouteMapView'i yeniden
     çizdiriyordu (telefonda ölçülebilir maliyet) — kaldıracak bir sayaç yok. */
  const startedMs = parseServerTimestampMs(room.round_started_at) ?? 0;
  const [nowMs, setNowMs] = useState(() => getSyncedNowMs());
  const counting = startedMs > nowMs;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNowMs(getSyncedNowMs()), 200);
    return () => clearInterval(id);
  }, [counting]);
  /* Yeni tur geldiğinde (roundKey değişimi) saat yeniden okunmalı — aksi hâlde
     `counting` bir önceki turun son değerinde donar ve interval hiç kurulmaz. */
  useEffect(() => { setNowMs(getSyncedNowMs()); }, [roundKey, startedMs]);

  const countdownLeft = startedMs > nowMs ? Math.ceil((startedMs - nowMs) / 1000) : 0;

  const roundWinnerId = room.round_winner_player_id;
  /* Tur YALNIZ biri hedefe ulaşınca biter. `round_deadline` OKUNMAZ: geçen
     süre ne turu ne maçı bitirir (sunucu tarafı 20260822120000). */
  const roundOver = roundWinnerId !== null;
  const iWonRound = roundWinnerId !== null && roundWinnerId === me?.id;
  const overtime = isOvertimeRound(room.current_round, room.total_rounds);

  /* Tur bittiğinde input'u boşalt (banner açıkken yazı kalmasın). */
  useEffect(() => {
    if (roundOver) setInput("");
  }, [roundOver]);

  /* Yeni tur aktif olunca input'a odaklan. */
  useEffect(() => {
    if (countdownLeft === 0 && !roundOver) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [countdownLeft, roundOver, roundKey]);

  /* ── Hamle gönderimi (lokal doğrulama → optimistic → sunucu uzlaşması) ── */
  const handleGuess = useCallback(async () => {
    // Kapı YALNIZ tur durumu: bitmiş tur ve başlamamış tur. Süreye bağlı kapı
    // YOK — eskiden `timeLeft <= 0` vardı ve `round_deadline` ayrıştırılamaz
    // ya da saat kaymışsa girişi sessizce ÖLDÜRÜYORDU.
    if (roundOver || countdownLeft > 0) return;
    if (submittingRef.current) return;
    const norm = normalizeInput(input);
    if (!norm) return;

    const key = NORM_TO_ROUTE_KEY[norm];
    if (!key) {
      showErr("Bu ülke tanınmıyor.");
      playSound("wrong");
      return;
    }
    if (key === currentKey) {
      showErr("Zaten bu ülkedesin.");
      playSound("wrong");
      return;
    }
    if (!getNeighbors(currentKey).includes(key)) {
      showErr(`"${routeKeyToDisplay(key)}" — ${routeKeyToDisplay(currentKey)} ile komşu değil.`);
      playSound("wrong");
      return;
    }

    // Optimistic: lokal path'e hemen ekle; sunucu reddederse geri sar.
    const prevPath = displayPath;
    const nextPath = [...displayPath, key];
    setLocalPath(nextPath);
    setInput("");

    submittingRef.current = true;
    try {
      const res = await onSubmitMove(key);
      if (!res.accepted) {
        // Kesin geri sarma: sunucu ne dediyse o (players realtime satırı da
        // aynı yöne yakınsar; burada anında geri döneriz).
        setLocalPath(prevPath);
        if (res.reason === "round_over" || res.reason === "dup") {
          showErr("Tur sona erdi.");
        } else if (res.reason === "not_started") {
          showErr("Tur henüz başlamadı.");
        } else if (res.reason === "not_neighbor") {
          showErr("Sunucu hamleyi reddetti (komşu değil).");
          playSound("wrong");
        }
        return;
      }
      if (res.finished && res.won) {
        // Turun kazananı — banner realtime room UPDATE ile gelir; ses hemen.
        playSound("correct");
        showOk("🏁 Hedefe ulaştın!");
      } else if (res.finished && !res.won) {
        showErr("Rakip senden önce tamamladı.");
      } else {
        playSound("correct");
        showOk("✓ Doğru komşu!");
      }
    } catch {
      setLocalPath(prevPath);
      showErr("Bağlantı hatası. Tekrar dene.");
    } finally {
      submittingRef.current = false;
    }
  }, [
    input, currentKey, displayPath, roundOver, countdownLeft,
    onSubmitMove, showErr, showOk,
  ]);

  /* Enter ile gönder / Escape ile temizle. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter") void handleGuess();
      if (e.key === "Escape") setInput("");
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [handleGuess]);

  const startDisplay = routeKeyToDisplay(startKey);
  const targetDisplay = routeKeyToDisplay(targetKey);
  const curDisplay = routeKeyToDisplay(currentKey);

  /* Dört durum (routeDuelConnection.ts, sunucu-heartbeat verisinden):
     unknown = ilk veri henüz gelmedi → nötr "Bağlanıyor…";
     connected = son sunucu heartbeat'i grace içinde (< 12 sn, yeşil);
     reconnecting = yaş ≥ 12 sn = 4 kaçırılmış beat AMA sunucu kesinleştirmedi
     → amber erken uyarı (20 sn aşılsa bile kırmızı DEĞİL);
     disconnected = SUNUCU kopuşu onayladı (finished_reason='disconnect')
     → ancak o zaman kırmızı "Bağlantı koptu". */
  const oppConnection = deriveOppConnectionView(oppStaleSeconds, isServerConfirmedDisconnect(room));

  return (
    <div className="route-screen rd-play-screen">
      {/* ══ ONLINE HUD ══
          Tek şerit. Telefonda (`compact`) geri düğmesi BURADA yaşar; üstte
          ayrı bir .duel-header YOKTUR (bkz. RouteDuelGame). Süre göstergesi
          KALDIRILDI — oyunun süre kuralı yok. */}
      <div className={"rd-hud" + (compact ? " rd-hud--compact" : "")}>
        <div className="rd-hud-left">
          {compact && (
            <button
              type="button"
              className="rd-hud-back"
              onClick={onExit}
              aria-label="Ana Menü"
              title="Ana Menü"
            >
              ←
            </button>
          )}
          <span className={"rd-round-chip" + (overtime ? " rd-round-chip--ot" : "")}>
            {overtime ? "⚔️ UZATMA" : `Tur ${room.current_round} / ${room.total_rounds}`}
          </span>
          <span className="route-goal rd-goal">
            <span className="route-start-label">{startDisplay}</span>
            <span className="route-arrow-big">→</span>
            <span className="route-target-label">{targetDisplay}</span>
          </span>
        </div>

        <div className="rd-hud-right">
          <div className="rd-score-pill">
            <span className="rd-score-name">{me?.name ?? "Sen"}</span>
            <span className="rd-score-val">{me?.score ?? 0}</span>
            <span className="rd-score-sep">·</span>
            <span className="rd-score-val">{opp?.score ?? 0}</span>
            <span className="rd-score-name">{opp?.name ?? "Rakip"}</span>
          </div>
          <span
            className={
              "rd-conn" +
              (oppConnection === "connected"
                ? " ok"
                : oppConnection === "reconnecting"
                  ? " reconnecting"
                  : oppConnection === "disconnected"
                    ? " lost"
                    : " connecting")
            }
            title={
              oppConnection === "connected"
                ? "Rakip bağlı"
                : oppConnection === "reconnecting"
                  ? "Rakibin bağlantısı zayıfladı — yeniden bağlanması bekleniyor"
                  : oppConnection === "disconnected"
                    ? "Rakibin bağlantısı koptu (sunucu doğruladı)"
                    : "Rakip bağlantısı doğrulanıyor"
            }
          >
            <span className="rd-conn-dot" />
            {oppConnection === "connected"
              ? "Bağlı"
              : oppConnection === "reconnecting"
                ? "Bağlantı zayıf…"
                : oppConnection === "disconnected"
                  ? "Bağlantı koptu"
                  : "Bağlanıyor…"}
          </span>
        </div>
      </div>

      {/* ══ MAP (offline RouteMapView aynen) ══ */}
      <div className="route-map-area">
        <RouteMapView
          routeKeys={displayPath.length > 0 ? displayPath : [startKey]}
          startKey={startKey}
          targetKey={targetKey}
          keyToTopoId={keyToTopoId}
        />
      </div>

      {/* ══ BOTTOM PANEL (offline giriş düzeni) ══ */}
      <div className="route-bottom">
        <div className="route-path-bar">
          <span className="route-path-meta">
            {stepsCount} adım &nbsp;·&nbsp; Şu an: <strong>{curDisplay}</strong>
          </span>
          <div className="route-path-chips">
            {displayPath.map((key, i) => (
              <span key={`${key}-${i}`} className="route-step-wrap">
                <span
                  className={
                    "route-step " +
                    (i === 0
                      ? "route-step-start"
                      : key === targetKey
                        ? "route-step-win"
                        : i === displayPath.length - 1
                          ? "route-step-current"
                          : "route-step-visited")
                  }
                >
                  {routeKeyToDisplay(key)}
                </span>
                {i < displayPath.length - 1 && <span className="route-chevron">›</span>}
              </span>
            ))}
            {currentKey !== targetKey && (
              <span className="route-step-wrap">
                <span className="route-chevron">›</span>
                <span className="route-step route-step-ghost">{targetDisplay}?</span>
              </span>
            )}
          </div>
        </div>

        <div className={"route-input-row " + (errMsg ? "err" : okMsg ? "ok" : "")}>
          <input
            ref={inputRef}
            type="text"
            className="route-input"
            placeholder={
              roundOver
                ? "Tur bitti — sonraki tur bekleniyor…"
                : countdownLeft > 0
                  ? "Tur başlıyor…"
                  : `${curDisplay} ile komşu ülke yaz… (Enter)`
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={roundOver || countdownLeft > 0}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button
            className="btn btn-accent"
            onClick={() => void handleGuess()}
            disabled={roundOver || countdownLeft > 0}
          >
            Gir
          </button>
        </div>

        <div className="route-action-row">
          <div className="route-feedback-slot">
            {errMsg && <span className="route-msg route-msg-err">⚠ {errMsg}</span>}
            {okMsg && <span className="route-msg route-msg-ok">{okMsg}</span>}
          </div>
        </div>
      </div>

      {/* ══ 3sn ORTAK GERİ SAYIM (sunucu round_started_at'e senkron) ══ */}
      {countdownLeft > 0 && !roundOver && (
        <div className="rd-countdown-backdrop" aria-live="polite">
          <div className="rd-countdown-panel">
            <p className="rd-countdown-label">
              {overtime ? "Uzatma turu başlıyor" : `Tur ${room.current_round} başlıyor`}
            </p>
            <p className="rd-countdown-route">
              {startDisplay} <span className="route-arrow-big">→</span> {targetDisplay}
            </p>
            <div className="rd-countdown-num">{countdownLeft}</div>
          </div>
        </div>
      )}

      {/* ══ TUR SONUCU (sunucu kararı; advance'i iki client da idempotent
          tetikleyebilir — host birincil, diğeri gecikmeli güvenlik ağı) ══ */}
      {roundOver && (
        <div className="rd-roundend-banner" role="status">
          {/* `roundOver` artık YALNIZ kazanan varken true → "süre doldu"
              (puansız berabere tur) durumu ARTIK OLUŞAMAZ; o dal kaldırıldı. */}
          {iWonRound ? (
            <span className="rd-roundend win">
              🏁 Turu kazandın! <strong>+1 puan</strong>
            </span>
          ) : (
            <span className="rd-roundend lose">
              {opp?.name ?? "Rakip"} hedefe önce ulaştı — turu aldı.
            </span>
          )}
          <span className="rd-roundend-next">Sonraki tur hazırlanıyor…</span>
        </div>
      )}
    </div>
  );
}
