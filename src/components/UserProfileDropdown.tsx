import { useEffect, useRef, useState } from "react";
import { getLevelProgress, fetchTotalXp } from "../lib/progression";
import type { Profile } from "../lib/auth";
import type { CountdownSoundMode } from "../lib/sound";

interface Props {
  profile: Profile | null;
  authLoading: boolean;
  gold: number;
  canBonus: boolean;
  soundEnabled: boolean;
  countdownSoundMode: CountdownSoundMode;
  onClaimBonus: () => void;
  onSetSoundEnabled: (enabled: boolean) => void;
  onSetCountdownSoundMode: (mode: CountdownSoundMode) => void;
  onLogout: () => void;
  onLogin: () => void;
  /** Parent ataması — dropdown açıldığında üst üste binmeleri kapatmak için. */
  onOpenChange?: (open: boolean) => void;
  /** "Adı Değiştir" butonuna basılınca modal açma sinyali parent'a gider. */
  onRequestUsernameChange?: () => void;
}

export function UserProfileDropdown({
  profile,
  authLoading,
  gold,
  canBonus,
  soundEnabled,
  countdownSoundMode,
  onClaimBonus,
  onSetSoundEnabled,
  onSetCountdownSoundMode,
  onLogout,
  onLogin,
  onOpenChange,
  onRequestUsernameChange,
}: Props) {
  const [open, setOpen] = useState(false);

  // Parent'a açık/kapalı sinyali — leaderboard butonunun gizlenmesi için.
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const [freshXp, setFreshXp] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Real XP lives in xp_events rows (sum), not profiles.xp.
  // Fetch once on mount and refresh on each dropdown open so the pill/popup show
  // the up-to-date level after duel matches.
  useEffect(() => {
    if (!profile) return;
    let alive = true;
    fetchTotalXp(profile.id).then((xp) => {
      if (alive) setFreshXp(xp);
    });
    return () => { alive = false; };
  }, [profile?.id, open]);

  // Reset fresh XP when profile changes (logout → new login)
  useEffect(() => {
    setFreshXp(null);
  }, [profile?.id]);

  // Close on outside click / ESC
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (authLoading) {
    return (
      <div className="upd-wrap">
        <div className="upd-pill upd-pill--loading">Kontrol ediliyor…</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="upd-wrap">
        <button type="button" className="upd-pill upd-pill--guest" onClick={onLogin}>
          Giriş Yap
        </button>
      </div>
    );
  }

  // Use freshly-fetched XP if available, fall back to profile snapshot
  const xp = freshXp ?? profile.xp;
  const lp = getLevelProgress(xp);
  const initial = (profile.username ?? "?")[0].toUpperCase();
  const pct = Math.round(lp.progressRatio * 100);
  const xpSpan = lp.nextLevelXp - lp.currentLevelXp;

  return (
    <div className="upd-wrap" ref={wrapRef}>
      {/* Pill trigger */}
      <button
        type="button"
        className={`upd-pill${open ? " upd-pill--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="upd-avatar">{initial}</span>
        <span className="upd-uname">@{profile.username}</span>
        <span className="upd-lv">Lv.&nbsp;{lp.level}</span>
        <span className="upd-chevron">{open ? "▲" : "▼"}</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="upd-dropdown">
          {/* — Header — */}
          <div className="upd-head">
            <span className="upd-head-avatar">{initial}</span>
            <div className="upd-head-info">
              <div className="upd-head-uname-row">
                <span className="upd-head-uname">@{profile.username}</span>
                {onRequestUsernameChange && (
                  <button
                    type="button"
                    className="upd-edit-uname"
                    onClick={() => {
                      setOpen(false);
                      onRequestUsernameChange();
                    }}
                    aria-label="Kullanıcı adını değiştir"
                    title="Kullanıcı adını değiştir"
                  >
                    Adı Değiştir
                  </button>
                )}
              </div>
              <span className="upd-head-level">Seviye {lp.level}</span>
            </div>
          </div>

          {/* — XP bar — */}
          <div className="upd-xp">
            <div className="upd-xp-track">
              <div className="upd-xp-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="upd-xp-labels">
              <span>{lp.xpIntoLevel} / {xpSpan} XP</span>
              <span>{lp.xpForNextLevel} XP kaldı</span>
            </div>
          </div>

          {/* — Gold — */}
          <div className="upd-row upd-row--gold">
            <span className="upd-gold-icon">🟡</span>
            <span className="upd-gold-num">{gold}</span>
            <span className="upd-gold-label">Gold</span>
          </div>

          {/* — Daily bonus — */}
          <div className="upd-section">
            <p className="upd-section-label">Günlük Bonus</p>
            {canBonus ? (
              <button
                type="button"
                className="upd-bonus-btn"
                onClick={onClaimBonus}
              >
                🎁 +50 Gold — Bugünkü Bonusu Al
              </button>
            ) : (
              <div className="upd-bonus-done">✓ Bugünkü bonus alındı · Yarın tekrar gel</div>
            )}
          </div>

          {/* — Sound settings — */}
          <div className="upd-section">
            <p className="upd-section-label">🔊 Ses Ayarları</p>

            <div className="upd-sound-block">
              <span className="upd-sound-sub">Genel Ses</span>
              <div className="upd-seg">
                <button
                  type="button"
                  className={`upd-seg-btn${soundEnabled ? " upd-seg-btn--active" : ""}`}
                  onClick={() => onSetSoundEnabled(true)}
                >Açık</button>
                <button
                  type="button"
                  className={`upd-seg-btn${!soundEnabled ? " upd-seg-btn--active" : ""}`}
                  onClick={() => onSetSoundEnabled(false)}
                >Kapalı</button>
              </div>
            </div>

            <div className="upd-sound-block">
              <span className="upd-sound-sub">Geri Sayım</span>
              <div className="upd-seg">
                {(["off", "last10", "last20"] as CountdownSoundMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`upd-seg-btn${countdownSoundMode === m ? " upd-seg-btn--active" : ""}`}
                    onClick={() => onSetCountdownSoundMode(m)}
                  >
                    {m === "off" ? "Kapalı" : m === "last10" ? "Son 10" : "Son 20"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* — Logout — */}
          <button
            type="button"
            className="upd-logout"
            onClick={() => { setOpen(false); onLogout(); }}
          >
            Çıkış Yap
          </button>
        </div>
      )}
    </div>
  );
}
