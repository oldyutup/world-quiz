/**
 * SocialCenterSheet.tsx — native app "Arkadaşlar" sosyal merkezi (bottom sheet).
 *
 * Native alt-nav'daki Arkadaşlar sekmesi bunu açar. Tek bir bottom-sheet içinde
 * sekmeli bir sosyal merkez:
 *   - Arkadaşlar   → arkadaş listesi (get_friends) + boş durum
 *   - İstekler     → gelen arkadaşlık istekleri (friend_request bildirimleri)
 *   - Bildirimler  → tüm bildirim merkezi (NotificationList)
 *   - Tema         → arka plan teması + kozmetik/sosyal ayar girişleri
 *
 * Veri SocialContext'ten (notifications, friendsRefreshKey) ve get_friends'ten
 * gelir; bildirim listesi/aksiyonları desktop paneliyle ortak NotificationList
 * üzerinden çalışır. Sadece native shell'de açılır (MobileHome alt-nav).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playSound } from "../lib/sound";
import { fetchFriends, type FriendRow } from "../lib/social";
import { useSocial } from "./SocialContext";
import { NotificationList } from "./NotificationList";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";

interface ThemeOption {
  id: string;
  name: string;
  swatch: string;
}

interface SocialCenterSheetProps {
  themes: ThemeOption[];
  activeTheme: string;
  onSelectTheme: (id: string) => void;
  onClose: () => void;
}

type SocialTab = "friends" | "requests" | "notifications" | "theme";

const TABS: { id: SocialTab; label: string }[] = [
  { id: "friends", label: "Arkadaşlar" },
  { id: "requests", label: "İstekler" },
  { id: "notifications", label: "Bildirimler" },
  { id: "theme", label: "Tema" },
];

export function SocialCenterSheet({
  themes,
  activeTheme,
  onSelectTheme,
  onClose,
}: SocialCenterSheetProps) {
  const social = useSocial();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<SocialTab>("friends");
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);

  const { notifications, friendsRefreshKey } = social;

  // Bekleyen (okunmamış) arkadaşlık istekleri → İstekler sekmesi badge'i.
  const pendingRequests = notifications.filter(
    (n) => n.type === "friend_request" && !n.read_at
  ).length;
  const unreadCount = notifications.filter((n) => !n.read_at).length;

  // Scroll lock + ESC (diğer mh-sheet'lerle aynı davranış).
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Arkadaşlar sekmesi açıkken (ve arkadaş değişiminde) listeyi çek.
  useEffect(() => {
    if (tab !== "friends") return;
    let alive = true;
    setFriendsLoading(true);
    void fetchFriends().then((rows) => {
      if (alive) {
        setFriends(rows);
        setFriendsLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [tab, friendsRefreshKey]);

  return createPortal(
    <>
      <div
        className="mh-sheet-backdrop"
        aria-hidden="true"
        onClick={() => {
          playSound("click");
          onClose();
        }}
      />
      <div
        ref={sheetRef}
        className="mh-sheet mh-sheet--social"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mh-social-title"
        tabIndex={-1}
      >
        <div className="mh-sheet-grab" aria-hidden="true" />
        <header className="mh-sheet-head">
          <span className="mh-sheet-icon" aria-hidden="true">👥</span>
          <h3 id="mh-social-title" className="mh-sheet-title">Arkadaşlar</h3>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => {
              playSound("click");
              onClose();
            }}
          >
            ✕
          </button>
        </header>

        <div className="social-tabs" role="tablist">
          {TABS.map((t) => {
            const count = t.id === "requests" ? pendingRequests : t.id === "notifications" ? unreadCount : 0;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`social-tab${tab === t.id ? " social-tab--active" : ""}`}
                onClick={() => {
                  playSound("click");
                  setTab(t.id);
                }}
              >
                {t.label}
                {count > 0 && <span className="social-tab-badge">{count > 99 ? "99+" : count}</span>}
              </button>
            );
          })}
        </div>

        <div className="social-tab-body">
          {tab === "friends" && (
            <div className="notif-list">
              {friendsLoading ? (
                <div className="notif-empty">Yükleniyor…</div>
              ) : friends.length === 0 ? (
                <div className="friends-empty">
                  <span className="friends-empty-title">Henüz arkadaşın yok</span>
                  <span className="friends-empty-sub">
                    Oyuncu profillerinden arkadaş ekleyebilirsin.
                  </span>
                </div>
              ) : (
                friends.map((f) => (
                  <PlayerProfileTrigger
                    key={f.profileId}
                    profileId={f.profileId}
                    className="friend-row"
                  >
                    <PlayerAvatar
                      avatarId={f.avatarId}
                      username={f.username}
                      size="sm"
                      frameId={f.activeAvatarFrameId}
                      className="friend-row-avatar"
                    />
                    <span className="friend-row-id">
                      <span className="friend-row-name">@{f.username ?? "—"}</span>
                      <span className="friend-row-level">Seviye {f.level}</span>
                    </span>
                    <span className="friend-row-status" aria-hidden="true" />
                  </PlayerProfileTrigger>
                ))
              )}
            </div>
          )}

          {tab === "requests" && (
            <NotificationList
              filter={(n) => n.type === "friend_request"}
              emptyText="Bekleyen arkadaşlık isteğin yok."
              onNavigate={onClose}
            />
          )}

          {tab === "notifications" && (
            <NotificationList emptyText="Henüz bildirim yok." onNavigate={onClose} />
          )}

          {tab === "theme" && (
            <div className="social-theme">
              <div className="social-section-label">Arka Plan Teması</div>
              <div className="mh-rows" role="menu" aria-label="Arka plan teması">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={"mh-theme-row" + (t.id === activeTheme ? " mh-theme-row--active" : "")}
                    role="menuitemradio"
                    aria-checked={t.id === activeTheme}
                    onClick={() => {
                      playSound("click");
                      onSelectTheme(t.id);
                    }}
                  >
                    <span className="mh-theme-swatch" style={{ background: t.swatch }} aria-hidden="true" />
                    <span className="mh-theme-name">{t.name}</span>
                    {t.id === activeTheme && <span className="mh-theme-check" aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>

              <div className="social-section-label">Kozmetik & Görünüm</div>
              <div className="social-cosmetic-grid">
                {[
                  { icon: "🖼️", label: "Çerçeveler" },
                  { icon: "🎨", label: "İsim Rengi" },
                  { icon: "🪪", label: "Kart Stili" },
                ].map((c) => (
                  <div key={c.label} className="social-cosmetic-card" aria-disabled="true">
                    <span className="social-cosmetic-icon" aria-hidden="true">{c.icon}</span>
                    <span className="social-cosmetic-label">{c.label}</span>
                    <span className="social-cosmetic-soon">Yakında</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
