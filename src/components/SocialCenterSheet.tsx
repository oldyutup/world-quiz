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
import {
  fetchFriends,
  searchPublicProfiles,
  sendFriendRequest,
  type FriendRow,
  type RelationshipStatus,
  type SearchProfileResult,
} from "../lib/social";
import { useSocial } from "./SocialContext";
import { useDm } from "./DmContext";
import { NotificationList } from "./NotificationList";
import { ClearNotificationsButton } from "./ClearNotificationsButton";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";
import GoldIcon from "./GoldIcon";
import {
  useDailyQuestStatus,
  useDailyQuestState,
  DAILY_QUEST_MODE_META,
  MOBILE_DAILY_QUEST_SOCIAL_VISIBLE,
} from "../lib/dailyQuest";

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
  /** Görev sekmesi: girişe göre nötr durum / badge kararı. */
  isLoggedIn: boolean;
  /** "Görev" sekmesi CTA'sı — sheet'i KAPATMADAN Günün Görevi modalını açar
   *  (App handler'ı yalnız modalı açar). Misafirde App'in mevcut auth gate'i devreye
   *  girer. Yeni görev mantığı YOK; mevcut DailyQuestModal yeniden kullanılır. */
  onOpenDailyQuest: () => void;
}

type SocialTab = "friends" | "requests" | "notifications" | "quest" | "theme";

const ALL_TABS: { id: SocialTab; label: string }[] = [
  { id: "friends", label: "Arkadaşlar" },
  { id: "requests", label: "İstekler" },
  { id: "notifications", label: "Bildirimler" },
  { id: "quest", label: "Görev" },
  { id: "theme", label: "Tema" },
];

/* "Görev" sekmesi KENDİ anahtarına bağlı (…_SOCIAL_VISIBLE): mobil ana menüde
   Günün Görevi girişi olmaması bu sekmeyi ARTIK kapatmaz — sheet, görevin mobil
   kalıcı girişidir. Kapalıyken sekme listeden düşer (panel kodu ve dq durum
   okuyucuları OLDUĞU GİBİ kalır, sadece ulaşılmaz olur). Bkz. lib/dailyQuest. */
const TABS = ALL_TABS.filter((t) => t.id !== "quest" || MOBILE_DAILY_QUEST_SOCIAL_VISIBLE);

/**
 * İlişki durumuna göre "Oyuncular" sonucu buton etiketi/aktifliği
 * (FriendsButton / PlayerProfileCard ile aynı dil; tek kaynak olamadı ama birebir aynı).
 */
function relationLabel(status: RelationshipStatus): { label: string; disabled: boolean } {
  switch (status) {
    case "self":
      return { label: "Sen", disabled: true };
    case "friends":
      return { label: "Arkadaşsınız", disabled: true };
    case "request_sent":
      return { label: "İstek Gönderildi", disabled: true };
    case "request_received":
      return { label: "Gelen İstek", disabled: true };
    default:
      return { label: "Arkadaş Ekle", disabled: false };
  }
}

export function SocialCenterSheet({
  themes,
  activeTheme,
  onSelectTheme,
  onClose,
  isLoggedIn,
  onOpenDailyQuest,
}: SocialCenterSheetProps) {
  const social = useSocial();
  const dm = useDm();
  const sheetRef = useRef<HTMLDivElement>(null);
  // Beş sekme dar ekranda (≤360px) tek satıra sığmayabilir → tab şeridi yatay
  // kaydırılabilir; sekme değişince aktifi tam görünür kaydır (metin kesilmez,
  // ikon-only'ye düşülmez). Geniş ekranda (fits) scroll oluşmaz.
  const tablistRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<SocialTab>("friends");

  // Günün Görevi — Görev sekmesi özeti. Tek kaynak: sunucu-otoriter dailyQuest
  // gözlemlenebilirleri (status = birincil karar; snapshot = başlık/mod/ödül/
  // ilerleme metni). Ayrı RPC atılmaz; App home'a girişte zaten tazeliyor.
  const dqStatus = useDailyQuestStatus();
  const dqState = useDailyQuestState();
  const dqQuest = dqState?.ok ? dqState.quest ?? null : null;
  const dqMeta = dqQuest ? DAILY_QUEST_MODE_META[dqQuest.mode] : null;
  const questPending =
    isLoggedIn &&
    (dqStatus === "available" || dqStatus === "active" || dqStatus === "reward_ready");
  const questStatusLabel = (() => {
    switch (dqStatus) {
      case "available": return "Bugünün görevi hazır";
      case "active": return "Görevin devam ediyor";
      case "reward_ready": return "Tamamlandı — ödülün hazır!";
      case "claimed": return "Bugünün görevi tamamlandı";
      default: return "Görev bilgisi yükleniyor…";
    }
  })();
  const questCtaLabel =
    dqStatus === "active" ? "Devam Et" : dqStatus === "reward_ready" ? "Ödülü Al" : "Göreve Başla";
  // Aktif attempt için kısa ilerleme satırı (modal ile aynı snapshot alanları).
  const questProgress = (() => {
    if (dqStatus !== "active" || !dqQuest) return null;
    const a = dqState?.ok ? dqState.attempt : null;
    if (!a || a.status !== "active") return null;
    switch (dqQuest.mode) {
      case "country_write": return `İlerleme: ${a.found_count ?? 0} / ${a.target ?? "?"} ülke`;
      case "flag_quiz": return `İlerleme: ${a.correct_count ?? 0} / ${a.required ?? "?"} doğru`;
      case "wheel_find": return `İlerleme: ${a.target_index ?? 0} / ${a.target_count ?? "?"} hedef`;
      case "route_complete": return `İlerleme: ${(a.path?.length ?? 1) - 1} adım`;
    }
  })();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);

  // Arkadaşlar sekmesi araması (lobi/FriendsButton ile aynı mantık; ana menüde
  // oda bağlamı yok → "Davet Et" yerine sadece arkadaş bulma + filtreleme + istek).
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchProfileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const { notifications, friendsRefreshKey, markAllRead, refreshNotifications } = social;

  // Arama için trim + baştaki "@" temizlenmiş hali; min uzunluk kontrolü buna göre.
  const trimmedQuery = query.replace(/^@+/, "").trim();
  const searchActive = trimmedQuery.length >= 2;

  // Yazılınca mevcut arkadaşları client-side filtrele (username includes).
  const friendIds = new Set(friends.map((f) => f.profileId));
  const filteredFriends = searchActive
    ? friends.filter((f) =>
        (f.username ?? "").toLowerCase().includes(trimmedQuery.toLowerCase())
      )
    : friends;
  // "Oyuncular" bölümü: zaten arkadaş olanları tekrar listeleme.
  const playerResults = results.filter((r) => !friendIds.has(r.profileId));

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

  // Aktif sekmeyi tab şeridinde tam görünür yap (dar ekran yatay scroll durumu).
  useEffect(() => {
    const active = tablistRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [tab]);

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

  // Bildirim/İstek sekmesi açılınca taze veri çek (desktop panelinin açılışta
  // refresh davranışıyla aynı; realtime fallback). refreshNotifications profile
  // id'ye bağlı stabil bir callback olduğundan her bildirim değişiminde tetiklenmez.
  useEffect(() => {
    if (tab === "notifications" || tab === "requests") void refreshNotifications();
  }, [tab, refreshNotifications]);

  // Friends sekmesinden çıkınca aramayı sıfırla (geri dönüşte temiz başlasın).
  useEffect(() => {
    if (tab !== "friends") {
      setQuery("");
      setResults([]);
    }
  }, [tab]);

  // Debounce'lu oyuncu araması: min 2 karakter, her tuşta değil (320ms).
  useEffect(() => {
    if (!searchActive) {
      setResults([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      void searchPublicProfiles(query).then((rows) => {
        if (alive) {
          setResults(rows);
          setSearching(false);
        }
      });
    }, 320);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query, searchActive]);

  // Arama sonucundan arkadaş isteği gönder — yine send_friend_request RPC (client insert YOK).
  const addFriend = async (r: SearchProfileResult) => {
    if (sendingId || r.relationshipStatus !== "none") return;
    setSendingId(r.profileId);
    const res = await sendFriendRequest(r.profileId);
    setSendingId(null);
    if (res.ok) {
      setResults((prev) =>
        prev.map((x) =>
          x.profileId === r.profileId ? { ...x, relationshipStatus: "request_sent" } : x
        )
      );
      social.toast("Arkadaşlık isteği gönderildi.");
    } else {
      social.toast(res.error ?? "İstek gönderilemedi.");
    }
  };

  // Arkadaş satırı — desktop FriendsButton paneliyle birebir: profil tetikleyici
  // + sağda mesaj (DM) butonu (okunmamış badge'li). DM butonu mevcut DM sistemini
  // kullanır (dm.openChatWith → getOrCreateConversation → global DMChatModal);
  // yeni sistem/sosyal akış YOK. Native "Arkadaşlar" sekmesinin doğrudan DM
  // giriş noktası budur; profil kartındaki "Mesaj Gönder" ile aynı thread'i açar.
  const renderFriendRow = (f: FriendRow) => {
    const unread = dm.unreadFor(f.profileId);
    return (
      <div key={f.profileId} className="friend-row-wrap">
        <PlayerProfileTrigger profileId={f.profileId} className="friend-row friend-row--dm">
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
        </PlayerProfileTrigger>
        <button
          type="button"
          className={"friend-dm-btn" + (unread > 0 ? " friend-dm-btn--unread" : "")}
          onClick={() =>
            dm.openChatWith({
              profileId: f.profileId,
              username: f.username,
              avatarId: f.avatarId,
              frameId: f.activeAvatarFrameId,
            })
          }
          aria-label={`@${f.username ?? ""} kişisine mesaj gönder`}
          title="Mesaj gönder"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6a2 2 0 0 1 2-2z"
            />
          </svg>
          {unread > 0 && (
            <span className="friend-dm-badge" aria-label={`${unread} okunmamış mesaj`}>
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </div>
    );
  };

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

        <div className="social-tabs" role="tablist" ref={tablistRef}>
          {TABS.map((t) => {
            const count =
              t.id === "requests" ? pendingRequests
              : t.id === "notifications" ? unreadCount
              : t.id === "quest" ? (questPending ? 1 : 0)
              : 0;
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
            <>
              {/* Arama: arkadaş içinde filtre + ekli olmayan oyuncu bul (sticky) */}
              <div className="friends-search">
                <span className="friends-search-icon" aria-hidden="true">🔍</span>
                <input
                  type="text"
                  className="friends-search-input"
                  placeholder="Arkadaş veya oyuncu ara"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Arkadaş veya oyuncu ara"
                />
                {query && (
                  <button
                    type="button"
                    className="friends-search-clear"
                    onClick={() => setQuery("")}
                    aria-label="Aramayı temizle"
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="notif-list">
                {!searchActive ? (
                  friendsLoading ? (
                    <div className="notif-empty">Yükleniyor…</div>
                  ) : friends.length === 0 ? (
                    <div className="friends-empty">
                      <span className="friends-empty-title">Henüz arkadaşın yok.</span>
                      <span className="friends-empty-sub">
                        Oyuncu adı veya profil kodu arayarak arkadaş ekleyebilirsin.
                      </span>
                    </div>
                  ) : (
                    friends.map((f) => renderFriendRow(f))
                  )
                ) : (
                  <>
                    {/* A) Mevcut arkadaşlar içinde client-side filtre */}
                    <div className="social-search-section-label">Arkadaşlar</div>
                    {filteredFriends.length === 0 ? (
                      <div className="notif-empty">Eşleşen arkadaş yok.</div>
                    ) : (
                      filteredFriends.map((f) => renderFriendRow(f))
                    )}

                    {/* B) Ekli olmayan oyuncular — RPC arama, istek atılabilir */}
                    <div className="social-search-section-label">Oyuncular</div>
                    {searching ? (
                      <div className="notif-empty">Aranıyor…</div>
                    ) : playerResults.length === 0 ? (
                      <div className="notif-empty">Eşleşen oyuncu bulunamadı.</div>
                    ) : (
                      playerResults.map((r) => {
                        const rel = relationLabel(r.relationshipStatus);
                        const sending = sendingId === r.profileId;
                        return (
                          <div key={r.profileId} className="friend-row friend-search-row">
                            <PlayerAvatar
                              avatarId={r.avatarId}
                              username={r.username}
                              size="sm"
                              frameId={r.activeAvatarFrameId}
                              className="friend-row-avatar"
                            />
                            <span className="friend-row-id">
                              <span className="friend-row-name">@{r.username ?? "—"}</span>
                              <span className="friend-row-level">
                                Seviye {r.level}
                                {r.profileCode ? ` · ${r.profileCode}` : ""}
                              </span>
                            </span>
                            <button
                              type="button"
                              className={"friend-add-btn" + (rel.disabled ? " is-disabled" : "")}
                              onClick={() => void addFriend(r)}
                              disabled={rel.disabled || sending}
                            >
                              {sending ? "Gönderiliyor…" : rel.label}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {tab === "requests" && (
            <NotificationList
              filter={(n) => n.type === "friend_request"}
              emptyText="Bekleyen arkadaşlık isteğin yok."
              onNavigate={onClose}
            />
          )}

          {tab === "notifications" && (
            <>
              {notifications.length > 0 && (
                <div className="social-notif-actions">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      className="notif-markall"
                      onClick={() => void markAllRead()}
                    >
                      Tümünü okundu yap
                    </button>
                  )}
                  <ClearNotificationsButton />
                </div>
              )}
              <NotificationList emptyText="Henüz bildirim yok." onNavigate={onClose} />
            </>
          )}

          {tab === "quest" && (
            <div className="social-quest">
              {!isLoggedIn ? (
                /* Misafir: nötr durum. CTA App'in mevcut auth gate'ini açar
                   (onOpenDailyQuest guest'te AuthModal). Görev badge'i yok. */
                <div className="social-quest-empty">
                  <img
                    className="social-quest-empty-icon"
                    src="/assets/icons/home/daily-quest-scroll.png"
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="social-quest-empty-title">Günün Görevi</span>
                  <span className="social-quest-empty-sub">
                    Giriş yaparak bugünün görevini oyna ve 50 Gold kazan.
                  </span>
                  <button
                    type="button"
                    className="social-quest-cta"
                    onClick={() => { playSound("click"); onOpenDailyQuest(); }}
                  >
                    Giriş Yap
                  </button>
                </div>
              ) : (
                <div className="social-quest-card">
                  <div className="social-quest-head">
                    <img
                      className="social-quest-icon"
                      src={dqMeta?.iconPath ?? "/assets/icons/home/daily-quest-scroll.png"}
                      alt=""
                      aria-hidden="true"
                    />
                    <div className="social-quest-headtext">
                      <span className="social-quest-title">{dqQuest?.title ?? "Günün Görevi"}</span>
                      <span className="social-quest-status">{questStatusLabel}</span>
                    </div>
                    {dqQuest && (
                      <span className="social-quest-reward" title="Görev ödülü">
                        <GoldIcon />
                        <span>+{dqQuest.reward_gold}</span>
                      </span>
                    )}
                  </div>
                  {dqQuest?.description && (
                    <p className="social-quest-desc">{dqQuest.description}</p>
                  )}
                  {questProgress && <p className="social-quest-progress">{questProgress}</p>}
                  {/* CTA sheet'i KAPATMADAN modalı açar (modal üstte; kapanınca
                      sheet açık kalır). Gerçek başlat/devam/claim modalda. */}
                  {dqStatus === "claimed" ? (
                    <div className="social-quest-done">
                      <span aria-hidden="true">✓</span> Bugünün görevi tamamlandı
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={
                        "social-quest-cta" +
                        (dqStatus === "reward_ready" ? " social-quest-cta--claim" : "")
                      }
                      onClick={() => { playSound("click"); onOpenDailyQuest(); }}
                    >
                      {questCtaLabel}
                    </button>
                  )}
                </div>
              )}
            </div>
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
