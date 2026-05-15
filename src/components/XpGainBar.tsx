/**
 * XpGainBar.tsx
 *
 * Oyun sonu XP kazanımı için ekranın altına sabit panel.
 *
 * Davranış:
 *   - Mount edildiğinde count-up animasyonu çalışır (prevXP → newXP).
 *   - Bar prevXP'nin level içindeki konumundan newXP'nin konumuna dolar.
 *   - Level atlandıysa "LEVEL UP!" rozeti ~2 sn belirir + levelup sesi.
 *   - Auto-dismiss: animasyon bittikten ~6 sn sonra panel kapanır.
 *   - Manuel kapatma butonu da var.
 *
 * Genel ve mod XP için iki satır gösterir. İkisi aynı anda animate olur.
 *
 * Pure presentational — XP yazma/RPC mantığı çağıran taraftadır (DuelGame).
 * Bu component sadece görsel; aynı XP iki kez gösterilmesin diye çağıran
 * taraf `key` prop'unu (örn. roomId) verirse, rematch sonrası temiz mount olur.
 */
import { useEffect, useRef, useState } from "react";
import {
  getLevelFromXp,
  getLevelProgress,
  type XpBreakdown,
} from "../lib/progression";
import { playSound } from "../lib/sound";

interface XpGainBarProps {
  /** Mod adı UI'da gösterilecek (örn. "Kapmaca", "Bayrak Düellosu"). */
  modeLabel: string;
  /** XP yazma öncesi genel XP. */
  prevTotalXp: number;
  /** XP yazma sonrası genel XP. */
  newTotalXp: number;
  /** XP yazma öncesi bu modun XP'si. */
  prevModeXp: number;
  /** XP yazma sonrası bu modun XP'si. */
  newModeXp: number;
  /** Bu çağrıda gerçekten eklenen XP (RPC'den). */
  xpEarned: number;
  /** RPC awarded === false ise "zaten verilmişti" notu için. */
  awarded: boolean;
  /** Breakdown — küçük puntoyla detay satırı. */
  breakdown: XpBreakdown;
  /** Kullanıcı X'e bastığında veya auto-dismiss tetiklendiğinde. */
  onDismiss: () => void;
}

/* ────────────────────────────────────────────────
   Süre sabitleri
   ──────────────────────────────────────────────── */
const COUNT_UP_MS    = 1400; // count-up + bar dolma süresi
const LEVELUP_FLASH_MS = 2000; // "LEVEL UP!" rozetinin görünme süresi

/* easeOutCubic — sonlara doğru yavaşlayan, doğal his veren easing */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/* requestAnimationFrame tabanlı count-up hook */
function useCountUp(from: number, to: number, durationMs: number): number {
  const [val, setVal] = useState(from);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Aynı değerde başla/bitse animasyon yok
    if (from === to) {
      setVal(to);
      return;
    }

    setVal(from);
    startRef.current = null;

    const step = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      const current = from + (to - from) * eased;
      setVal(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setVal(to);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [from, to, durationMs]);

  return val;
}

export default function XpGainBar({
  modeLabel,
  prevTotalXp,
  newTotalXp,
  prevModeXp,
  newModeXp,
  xpEarned,
  awarded,
  breakdown,
  onDismiss,
}: XpGainBarProps) {
  /* Count-up değerleri */
  const animTotal = useCountUp(prevTotalXp, newTotalXp, COUNT_UP_MS);
  const animMode  = useCountUp(prevModeXp,  newModeXp,  COUNT_UP_MS);

  /* Level atlama tespiti — sadece mount sırasında bir kez */
  const prevTotalLevel = getLevelFromXp(prevTotalXp);
  const newTotalLevel  = getLevelFromXp(newTotalXp);
  const prevModeLevel  = getLevelFromXp(prevModeXp);
  const newModeLevel   = getLevelFromXp(newModeXp);
  const leveledUpTotal = newTotalLevel > prevTotalLevel;
  const leveledUpMode  = newModeLevel  > prevModeLevel;
  const anyLevelUp     = leveledUpTotal || leveledUpMode;

  /* Level-up flash state'i */
  const [showLevelUp, setShowLevelUp] = useState(false);

  /* Mount efekti: ses + level-up flash (auto-dismiss yok — kullanıcı X'e bassın) */
  useEffect(() => {
    let levelUpTimer: ReturnType<typeof setTimeout> | null = null;
    let flashHideTimer: ReturnType<typeof setTimeout> | null = null;

    if (anyLevelUp) {
      // Bar dolduktan hemen sonra (görsel olarak "doldu → patladı" hissi)
      levelUpTimer = setTimeout(() => {
        setShowLevelUp(true);
        playSound("levelup", { restart: true });
      }, COUNT_UP_MS - 200);

      flashHideTimer = setTimeout(() => {
        setShowLevelUp(false);
      }, COUNT_UP_MS - 200 + LEVELUP_FLASH_MS);
    }

    return () => {
      if (levelUpTimer)    clearTimeout(levelUpTimer);
      if (flashHideTimer)  clearTimeout(flashHideTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // sadece mount

  /* Render değerleri */
  const totalProgress = getLevelProgress(Math.round(animTotal));
  const totalProgressPct = Math.round(totalProgress.progressRatio * 100);
  const totalLevelDisplay = getLevelFromXp(Math.round(animTotal));

  const modeProgress = getLevelProgress(Math.round(animMode));
  const modeProgressPct = Math.round(modeProgress.progressRatio * 100);
  const modeLevelDisplay = getLevelFromXp(Math.round(animMode));

  return (
    <div className="xpgain-root" role="status" aria-live="polite">
      <div className={`xpgain-panel ${anyLevelUp ? "xpgain-panel-lvlup" : ""}`}>
        {/* Sol: +X XP başlık */}
        <div className="xpgain-head">
          <span className="xpgain-plus">
            +{xpEarned} <span className="xpgain-plus-suffix">XP</span>
          </span>
          {!awarded && (
            <span className="xpgain-note">zaten verilmişti</span>
          )}

          {/* Level-up flash rozeti */}
          {showLevelUp && (
            <span className="xpgain-levelup-flash" aria-label="Level atladın!">
              🎉 LEVEL UP!
            </span>
          )}
        </div>

        {/* Orta: breakdown + iki level satırı */}
        <div className="xpgain-body">
          <div className="xpgain-breakdown">
            <span>Katılım +{breakdown.participation}</span>
            <span className="xpgain-dot">·</span>
            <span>{breakdown.correctCount} doğru +{breakdown.correctTotal}</span>
            <span className="xpgain-dot">·</span>
            <span>
              {breakdown.resultBonusLabel === "win"  && `Galibiyet +${breakdown.resultBonus}`}
              {breakdown.resultBonusLabel === "draw" && `Beraberlik +${breakdown.resultBonus}`}
              {breakdown.resultBonusLabel === "loss" && `Mağlubiyet +${breakdown.resultBonus}`}
            </span>
          </div>

          <div className="xpgain-rows">
            {/* Genel level satırı */}
            <div className={`xpgain-row ${leveledUpTotal ? "xpgain-row-lvlup" : ""}`}>
              <span className="xpgain-label">Genel</span>
              <span className="xpgain-level">Lv {totalLevelDisplay}</span>
              <div className="xpgain-bar">
                <div
                  className="xpgain-bar-fill"
                  style={{ width: `${totalProgressPct}%` }}
                />
                {leveledUpTotal && <div className="xpgain-bar-shine" />}
              </div>
              <span className="xpgain-xp">
                {totalProgress.xpIntoLevel}/{totalProgress.nextLevelXp - totalProgress.currentLevelXp}
              </span>
            </div>

            {/* Mod level satırı */}
            <div className={`xpgain-row ${leveledUpMode ? "xpgain-row-lvlup" : ""}`}>
              <span className="xpgain-label">{modeLabel}</span>
              <span className="xpgain-level">Lv {modeLevelDisplay}</span>
              <div className="xpgain-bar">
                <div
                  className="xpgain-bar-fill"
                  style={{ width: `${modeProgressPct}%` }}
                />
                {leveledUpMode && <div className="xpgain-bar-shine" />}
              </div>
              <span className="xpgain-xp">
                {modeProgress.xpIntoLevel}/{modeProgress.nextLevelXp - modeProgress.currentLevelXp}
              </span>
            </div>
          </div>
        </div>

        {/* Sağ: kapat */}
        <button
          className="xpgain-close"
          onClick={onDismiss}
          type="button"
          aria-label="Kapat"
        >
          ✕
        </button>
      </div>
    </div>
  );
}