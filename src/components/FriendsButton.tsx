/**
 * FriendsButton.tsx — arkadaş listesi tetikleyici + panel (ortak).
 *
 * Desktop web: sağ üstte ikon buton, tıklayınca dropdown panel.
 * Mobil web / native iOS/app: aynı tetikleyici; panel bottom-sheet olarak açılır
 * (safe-area korunur). NotificationCenter ile aynı görsel dil.
 *
 * Variant:
 *   - "icon" (varsayılan) → sağ üst social-bar içinde 👥 ikon buton.
 *   - "row"               → native profil panelinde tam-genişlik menü satırı.
 *
 * Panel iki bölge gösterir:
 *   1) ÜSTTE arama: oyuncu adı (@username) VEYA profil kodu ile yeni oyuncu bul.
 *      Min 2 karakter + debounce; search_public_profiles RPC (searchPublicProfiles).
 *      Sonuçta avatar/username/seviye + ilişki durumuna göre buton
 *      (Arkadaş Ekle / İstek Gönderildi / Arkadaşsınız / Yanıt Bekliyor / Sen).
 *      Ekleme yine send_friend_request RPC'sinden geçer (client insert YOK).
 *   2) ALTTA arkadaşlarım: get_friends RPC (fetchFriends) — açılışta + arkadaş
 *      değişiminde (SocialContext.friendsRefreshKey) tek çağrıda, N+1 yok. Bir
 *      arkadaş satırına basınca PlayerProfileTrigger public profil kartını açar.
 *
 * Arama aktifken (input dolu) sonuçlar, boşken arkadaş listesi gösterilir.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "../lib/useIsMobile";
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
import { usePresenceOptional } from "./PresenceContext";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";
import { EmojiIcon } from "./EmojiIcon";

interface FriendsButtonProps {
  variant?: "bar" | "icon" | "row";
}

/** İlişki durumuna göre arama sonucu buton etiketi/aktifliği (PlayerProfileCard ile aynı dil). */
function relationLabel(status: RelationshipStatus): { label: string; disabled: boolean } {
  switch (status) {
    case "self":
      return { label: "Sen", disabled: true };
    case "friends":
      return { label: "Arkadaşsınız", disabled: true };
    case "request_sent":
      return { label: "İstek Gönderildi", disabled: true };
    case "request_received":
      return { label: "Yanıt Bekliyor", disabled: true };
    default:
      return { label: "Arkadaş Ekle", disabled: false };
  }
}

export function FriendsButton({ variant = "bar" }: FriendsButtonProps) {
  const social = useSocial();
  const dm = useDm();
  const presence = usePresenceOptional();
  const refreshPresence = presence.refresh; // stabil kimlik (useCallback)
  const { isMobile } = useIsMobile();
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Arama durumu.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchProfileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const { friendsRefreshKey } = social;

  // Arama için trim + "@" temizlenmiş hali; min uzunluk kontrolü buna göre.
  const trimmedQuery = query.replace(/^@+/, "").trim();
  const searchActive = trimmedQuery.length >= 2;

  // Açılışta + arkadaş değişiminde (kabul sonrası) taze veri.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void fetchFriends().then((rows) => {
      if (alive) {
        setFriends(rows);
        setLoading(false);
      }
    });
    // Panel açılırken online arkadaş kümesini hemen tazele (nokta anlık doğru olsun).
    void refreshPresence();
    return () => {
      alive = false;
    };
  }, [open, friendsRefreshKey, refreshPresence]);

  // Panel kapanınca aramayı sıfırla (yeniden açılışta temiz başlasın).
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  // Debounce'lu arama: min 2 karakter sonra, her tuşta değil.
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

  // Dışarı tık / ESC kapatma (desktop dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!social.profile) return null;

  // Bekleyen (okunmamış) arkadaşlık isteği sayısı + okunmamış DM toplamı.
  // İkisi de kırmızı "dikkat" göstergesi; tek badge'te toplanır (arkadaş
  // toplamı ayrı, panel başlığındaki .notif-panel-count olarak korunur).
  const pendingRequests = social.notifications.filter(
    (n) => n.type === "friend_request" && !n.read_at
  ).length;
  const attentionCount = pendingRequests + dm.totalUnread;

  const badge =
    attentionCount > 0 ? (
      <span
        className={variant === "row" ? "social-menu-row-badge" : "social-btn-badge"}
        aria-label={`${dm.totalUnread} okunmamış mesaj, ${pendingRequests} bekleyen istek`}
      >
        {attentionCount > 99 ? "99+" : attentionCount}
      </span>
    ) : null;

  // Okunmamış DM'i olan arkadaşları üste taşı (stabil; mevcut sıra korunur).
  const sortedFriends = useMemo(() => {
    return friends
      .map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const ua = dm.unreadFor(a.f.profileId);
        const ub = dm.unreadFor(b.f.profileId);
        if (ua !== ub) return ub - ua;
        return a.i - b.i;
      })
      .map((x) => x.f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, dm.unread]);

  // Arama sonucundan arkadaş isteği gönder — yine send_friend_request RPC.
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

  const trigger =
    variant === "row" ? (
      <button
        type="button"
        className="social-menu-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="social-menu-row-icon" aria-hidden="true"><EmojiIcon name="people" /></span>
        <span className="social-menu-row-label">Arkadaşlar</span>
        {badge}
      </button>
    ) : variant === "bar" ? (
      <button
        type="button"
        className={`social-btn${open ? " social-btn--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Arkadaşlar"
        aria-expanded={open}
      >
        <span className="social-btn-icon" aria-hidden="true"><EmojiIcon name="people" /></span>
        <span className="social-btn-label">Arkadaşlar</span>
        {badge}
      </button>
    ) : (
      <button
        type="button"
        className={`notif-bell${open ? " notif-bell--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Arkadaşlar"
        aria-expanded={open}
      >
        <span className="notif-bell-icon" aria-hidden="true"><EmojiIcon name="people" /></span>
        {badge}
      </button>
    );

  return (
    <div className="notif-wrap" ref={wrapRef}>
      {trigger}

      {open && (
        <>
          {isMobile && <div className="notif-sheet-backdrop" onClick={() => setOpen(false)} />}
          <div className={`notif-panel${isMobile ? " notif-panel--sheet" : ""}`}>
            <div className="notif-panel-head">
              <span className="notif-panel-title">Arkadaşlar</span>
              {!searchActive && friends.length > 0 && (
                <span className="notif-panel-count">{friends.length}</span>
              )}
            </div>

            {/* Oyuncu arama (sticky, head'in hemen altında) */}
            <div className="friends-search">
              <span className="friends-search-icon" aria-hidden="true">🔍</span>
              <input
                type="text"
                className="friends-search-input"
                placeholder="Oyuncu adı veya profil kodu ara"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Oyuncu adı veya profil kodu ara"
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
              {searchActive ? (
                searching ? (
                  <div className="notif-empty">Aranıyor…</div>
                ) : results.length === 0 ? (
                  <div className="friends-empty">
                    <span className="friends-empty-title">Oyuncu bulunamadı</span>
                    <span className="friends-empty-sub">
                      Adı veya profil kodunu kontrol et.
                    </span>
                  </div>
                ) : (
                  results.map((r) => {
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
                )
              ) : loading ? (
                <div className="notif-empty">Yükleniyor…</div>
              ) : friends.length === 0 ? (
                <div className="friends-empty">
                  <span className="friends-empty-title">Henüz arkadaşın yok</span>
                  <span className="friends-empty-sub">
                    Oyuncu adı veya profil kodu arayarak arkadaş ekleyebilirsin.
                  </span>
                </div>
              ) : (
                sortedFriends.map((f) => {
                  const unread = dm.unreadFor(f.profileId);
                  const online = presence.isOnline(f.profileId);
                  return (
                    <div key={f.profileId} className="friend-row-wrap">
                      <PlayerProfileTrigger
                        profileId={f.profileId}
                        className="friend-row friend-row--dm"
                      >
                        <span className="friend-avatar-wrap">
                          <PlayerAvatar
                            avatarId={f.avatarId}
                            username={f.username}
                            size="sm"
                            frameId={f.activeAvatarFrameId}
                            className="friend-row-avatar"
                          />
                          <span
                            className={`presence-dot presence-dot--${online ? "online" : "offline"}`}
                            aria-label={online ? "Çevrimiçi" : "Çevrimdışı"}
                          />
                        </span>
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
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
