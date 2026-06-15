import { useEffect, useRef, useState, type ReactNode } from "react";
import { getLevelProgress, fetchTotalXp } from "../lib/progression";
import type { Profile } from "../lib/auth";
import type { CountdownSoundMode } from "../lib/sound";
import { Avatar } from "./Avatar";

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
  /** Opsiyonel controlled mod: verildiğinde açık/kapalı durumu parent yönetir
   *  (native bottom-nav Profil sekmesi için). Tanımsızsa bileşen kendi iç
   *  state'ini kullanır — web davranışı değişmez. */
  controlledOpen?: boolean;
  /** "Adı Değiştir" butonuna basılınca modal açma sinyali parent'a gider. */
  onRequestUsernameChange?: () => void;
  /** "Avatarı Değiştir" butonuna basılınca avatar seçim modalını açar. */
  onRequestAvatarChange?: () => void;
  /** Native profil panelinde gösterilen sosyal menü satırları
   *  (Bildirimler / Arkadaşlar). Desktop+mobil web'de bunlar üst social-bar'da
   *  durduğu için verilmez. */
  socialMenu?: ReactNode;
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
  controlledOpen,
  onRequestUsernameChange,
  onRequestAvatarChange,
  socialMenu,
}: Props) {
  // Open state is internal by default; when `controlledOpen` is provided the
  // parent owns it (native bottom-nav). Either way every open/close routes
  // through setOpen, which notifies the parent via onOpenChange.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
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
  const pct = Math.round(lp.progressRatio * 100);
  const xpSpan = lp.nextLevelXp - lp.currentLevelXp;

  return (
    <div className="upd-wrap" ref={wrapRef}>
      {/* Pill trigger */}
      <button
        type="button"
        className={`upd-pill${open ? " upd-pill--open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Avatar
          avatarId={profile.avatar_id}
          username={profile.username}
          className="upd-avatar"
        />
        <span className="upd-uname">@{profile.username}</span>
        <span className="upd-lv">Lv.&nbsp;{lp.level}</span>
        <span className="upd-chevron">{open ? "▲" : "▼"}</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="upd-dropdown">
          {/* — Header — */}
          <div className="upd-head">
            {onRequestAvatarChange ? (
              <button
                type="button"
                className="upd-head-avatar-btn"
                onClick={() => {
                  setOpen(false);
                  onRequestAvatarChange();
                }}
                aria-label="Avatarı değiştir"
                title="Avatarı değiştir"
              >
                <Avatar
                  avatarId={profile.avatar_id}
                  username={profile.username}
                  className="upd-head-avatar"
                />
                <span className="upd-head-avatar-edit" aria-hidden="true">✎</span>
              </button>
            ) : (
              <Avatar
                avatarId={profile.avatar_id}
                username={profile.username}
                className="upd-head-avatar"
              />
            )}
            <div className="upd-head-info">
              <span className="upd-head-uname">@{profile.username}</span>
              <span className="upd-head-level">Seviye {lp.level}</span>
            </div>
          </div>

          {/* — Sosyal menü (native: Bildirimler / Arkadaşlar) — */}
          {socialMenu && <div className="upd-social-menu">{socialMenu}</div>}

          {/* — Edit actions (balanced two-up row, no longer cramped) — */}
          {(onRequestUsernameChange || onRequestAvatarChange) && (
            <div className="upd-edit-actions">
              {onRequestUsernameChange && (
                <button
                  type="button"
                  className="upd-edit-btn"
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
              {onRequestAvatarChange && (
                <button
                  type="button"
                  className="upd-edit-btn"
                  onClick={() => {
                    setOpen(false);
                    onRequestAvatarChange();
                  }}
                  aria-label="Avatarı değiştir"
                  title="Avatarı değiştir"
                >
                  Avatarı Değiştir
                </button>
              )}
            </div>
          )}

          {/* — XP / level progress — */}
          <div className="upd-xp">
            <span className="upd-xp-title">Seviye İlerlemesi</span>
            <div className="upd-xp-track">
              <div className="upd-xp-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="upd-xp-labels">
              <span>{lp.xpIntoLevel} / {xpSpan} XP</span>
              <span className="upd-xp-remain">{lp.xpForNextLevel} XP kaldı</span>
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
