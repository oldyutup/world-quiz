/**
 * ProfileEditModal.tsx — merkezi "Profili Düzenle" modalı (hub).
 *
 * Tek giriş noktası: profil kartındaki "Profili Düzenle" bu modalı açar. Modal
 * yalnızca bir yönlendirme merkezidir — kendi işini yapmaz, mevcut akışları
 * tetikler:
 *   - "Kullanıcı adı ve şifre" → AccountSettingsModal (App yönetir)
 *   - "Avatarı Değiştir"       → mevcut AvatarPickerModal (App yönetir)
 *   - "Rozetleri Sergile"      → yeni BadgeShowcaseEditor (App yönetir)
 *
 * Mevcut username / avatar / achievement sistemlerine DOKUNMAZ; sadece UX'i
 * tek merkezde toplar. Premium koyu-mavi cam modal stili (.pem-*), apk/uc ile
 * aynı z-band. Desktop/mobil web ortak; native özel dosyalara dokunulmaz.
 */
import { useEffect } from "react";
import type { Profile } from "../lib/auth";

interface Props {
  profile: Profile;
  onClose: () => void;
  /** "Kullanıcı adı ve şifre" → AccountSettingsModal (ad + şifre yönetimi). */
  onChooseAccount: () => void;
  /** "Avatarı Değiştir" → mevcut avatar seçme akışı. */
  onChooseAvatar: () => void;
  /** "Rozetleri Sergile" → rozet sergileme editörü. */
  onChooseBadges: () => void;
  /** "Engellenen Kullanıcılar" → engelli kullanıcı yönetim modalı. */
  onChooseBlocked: () => void;
}

function NameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.5 19.5a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

function AvatarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="2.8" />
      <path d="M6.5 18.2a6 6 0 0 1 11 0" />
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="9" r="5" />
      <path d="M9 13.2 7.5 21l4.5-2.4L16.5 21 15 13.2" />
    </svg>
  );
}

function BlockedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function CosmeticsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-1 .8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-3.6-4-6.6-9-6.6Z" />
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="11" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="pem-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

interface Action {
  key: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** Altyapı hazır ama henüz aktif değil → "Yakında" rozeti, tıklanamaz. */
  comingSoon?: boolean;
}

export function ProfileEditModal({
  profile,
  onClose,
  onChooseAccount,
  onChooseAvatar,
  onChooseBadges,
  onChooseBlocked,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const actions: Action[] = [
    {
      key: "account",
      title: "Kullanıcı adı ve şifre",
      desc: "Kullanıcı adını veya giriş şifreni yönet.",
      icon: <NameIcon />,
      onClick: onChooseAccount,
    },
    {
      key: "avatar",
      title: "Avatarı Değiştir",
      desc: "Açtığın avatarlardan birini seç.",
      icon: <AvatarIcon />,
      onClick: onChooseAvatar,
    },
    {
      key: "badges",
      title: "Rozetleri Sergile",
      desc: "Profilinde göstermek için 5 başarım seç.",
      icon: <BadgeIcon />,
      onClick: onChooseBadges,
    },
    {
      key: "blocked",
      title: "Engellenen Kullanıcılar",
      desc: "Engellediğin kullanıcıları görüntüle ve yönet.",
      icon: <BlockedIcon />,
      onClick: onChooseBlocked,
    },
    {
      // Kozmetik altyapı hazır (profile_cosmetics: frame/theme/name color/title/
      // effect); editör + mağaza sonraki faza bırakıldı. Şimdilik placeholder.
      key: "appearance",
      title: "Profil Görünümü",
      desc: "Kart temaları, çerçeveler ve unvanlar yakında.",
      icon: <CosmeticsIcon />,
      onClick: () => {},
      comingSoon: true,
    },
  ];

  return (
    <div
      className="pem-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Profili Düzenle"
      onClick={onClose}
    >
      <div className="pem-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pem-close" onClick={onClose} aria-label="Kapat">
          ×
        </button>

        <div className="pem-head">
          <h2 className="pem-title">Profili Düzenle</h2>
          <p className="pem-sub">Profilini kişiselleştir ve başarımlarını sergile.</p>
        </div>

        <div className="pem-list">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`pem-row${a.comingSoon ? " pem-row--soon" : ""}`}
              onClick={a.comingSoon ? undefined : a.onClick}
              disabled={a.comingSoon}
              aria-disabled={a.comingSoon || undefined}
            >
              <span className="pem-row-icon" aria-hidden="true">
                {a.icon}
              </span>
              <span className="pem-row-body">
                <span className="pem-row-title">{a.title}</span>
                <span className="pem-row-desc">{a.desc}</span>
              </span>
              {a.comingSoon ? <span className="pem-soon">Yakında</span> : <Chevron />}
            </button>
          ))}
        </div>

        <p className="pem-foot">@{profile.username ?? "—"}</p>
      </div>
    </div>
  );
}
