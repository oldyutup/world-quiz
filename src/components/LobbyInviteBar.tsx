/**
 * LobbyInviteBar.tsx — tüm online lobilerde ortak davet alanı.
 *
 * Oda kodunun hemen altında iki buton gösterir:
 *   [📋 Linki Kopyala]  [👥 Arkadaş Davet Et]
 *
 *   - Linki Kopyala  : mevcut davranış korunur (tam davet mesajını panoya yazar,
 *                       başarısızlıkta window.prompt fallback). Başarıda toast.
 *   - Arkadaş Davet Et: davet/ekleme panelini açar (desktop'ta ortalı modal,
 *                       mobil web / native'de bottom-sheet — PlayerProfileTrigger
 *                       ile aynı .ppc-overlay deseni).
 *
 * Panelde TEK arama kutusu vardır ("Arkadaş veya oyuncu ara"):
 *   - Boşken     : mevcut arkadaş listesi (her satırda avatar/username/seviye +
 *                  "Davet Et"). Davet send_room_invite RPC ile gider; aynı odada
 *                  aynı kişiye tekrar davet engellenir.
 *   - Yazarken   : (A) "Arkadaşlar" bölümünde mevcut arkadaşlar client-side
 *                  filtrelenir (Davet Et). (B) ≥2 karakterde "Oyuncular" bölümü
 *                  debounce'lu search_public_profiles RPC ile ekli OLMAYAN
 *                  oyuncuları da listeler; ilişki durumuna göre buton
 *                  (Arkadaş Ekle / İstek Gönderildi / Yanıt Bekliyor / Sen).
 *
 * GÜVENLİK: Arkadaş olmayan oyuncuya ODA daveti gösterilmez (spam riski). Onlar
 * için yalnız "Arkadaş Ekle" → send_friend_request RPC (client insert YOK).
 * Arkadaş olduktan sonra kişi bu panelden davet edilebilir.
 *
 * Oda link/input alanı bu bileşenin DIŞINDA, çağıran lobide kalır (butonların
 * altında). Desktop web, mobil web ve native iOS/app'te aynı bileşendir.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import {
  fetchFriends,
  searchPublicProfiles,
  sendFriendRequest,
  sendRoomInvite,
  type FriendRow,
  type RelationshipStatus,
  type SearchProfileResult,
} from "../lib/social";
import { useSocial } from "./SocialContext";
import { PlayerAvatar } from "./PlayerAvatar";

interface LobbyInviteBarProps {
  /** Panoya yazılacak tam davet mesajı (link dahil). */
  inviteMessage: string;
  /** Kopyalama başarısızsa prompt'ta gösterilecek ham link. */
  shareLink: string;
  /** Davet payload'u — send_room_invite RPC'sine gider. */
  roomCode: string;
  mode: string;
  /** Göreli oda linki, ör. "/?duel=ABC123". */
  roomUrl: string;
  /**
   * Opsiyonel: "Arkadaş Davet Et" butonunda metnin solunda gösterilecek özel
   * ikon (verilmezse 👥 emoji). Lobi-türüne özel görsel için çağıran lobi
   * (ör. Kuşatma) geçer — paylaşılan bileşen modlara bağımlı kalmaz.
   */
  friendsButtonIcon?: ReactNode;
  /**
   * Opsiyonel: "Linki Kopyala" butonunda metnin solunda gösterilecek özel
   * ikon (verilmezse 📋 emoji). Yalnız Kuşatma geçer.
   */
  copyButtonIcon?: ReactNode;
}

/** İlişki durumuna göre "Oyuncular" bölümü buton etiketi/aktifliği (FriendsButton ile aynı dil). */
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

export function LobbyInviteBar({
  inviteMessage,
  shareLink,
  roomCode,
  mode,
  roomUrl,
  friendsButtonIcon,
  copyButtonIcon,
}: LobbyInviteBarProps) {
  const social = useSocial();
  const { isMobile } = useIsMobile();

  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Oda daveti gönderiliyor (send_room_invite).
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Arkadaşlık isteği gönderiliyor (send_friend_request).
  const [addingId, setAddingId] = useState<string | null>(null);
  // Tek arama kutusu: hem arkadaş filtresi hem oyuncu araması.
  const [search, setSearch] = useState("");
  // Bu oda oturumunda davet edilenler — tekrar tekrar spam'i engeller.
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  // Public oyuncu arama sonuçları.
  const [results, setResults] = useState<SearchProfileResult[]>([]);
  const [searching, setSearching] = useState(false);

  // "@" önekini yok say; case-insensitive arkadaş filtresi buna göre.
  const cleaned = search.replace(/^@+/, "").trim();
  const q = cleaned.toLowerCase();
  // Sunucu sorgusu (search_public_profiles) yalnız ≥2 karakterde; her tuşta değil.
  const searchActive = cleaned.length >= 2;

  // Arkadaş listesi içinde client-side filtre (liste zaten elde — sorgu yok).
  const visibleFriends = q
    ? friends.filter((f) => (f.username ?? "").toLowerCase().includes(q))
    : friends;

  // "Oyuncular" bölümünde arkadaşları gösterme (zaten "Arkadaşlar"da) — tekrarı önle.
  const friendIds = useMemo(() => new Set(friends.map((f) => f.profileId)), [friends]);
  const players = useMemo(
    () => results.filter((r) => !friendIds.has(r.profileId)),
    [results, friendIds]
  );

  const copyLink = useCallback(() => {
    const text = inviteMessage || shareLink;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        social.toast("Davet linki kopyalandı!");
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        window.prompt("Linki kopyala:", shareLink);
      });
  }, [inviteMessage, shareLink, social]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    setSearch("");
    setResults([]);
    setSearching(false);
    setLoading(true);
    void fetchFriends().then((rows) => {
      setFriends(rows);
      setLoading(false);
    });
  }, []);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  // ESC ile kapat (PlayerProfileTrigger ile aynı davranış).
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pickerOpen, closePicker]);

  // Debounce'lu oyuncu araması: panel açıkken, min 2 karakter sonra.
  useEffect(() => {
    if (!pickerOpen || !searchActive) {
      setResults([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      void searchPublicProfiles(search).then((rows) => {
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
  }, [search, searchActive, pickerOpen]);

  // Arkadaşa oda daveti gönder (send_room_invite).
  const invite = useCallback(
    async (profileId: string) => {
      if (invitedIds.has(profileId) || sendingId) return;
      setSendingId(profileId);
      const res = await sendRoomInvite({
        recipientProfileId: profileId,
        roomCode,
        mode,
        roomUrl,
      });
      setSendingId(null);
      if (res.ok) {
        setInvitedIds((prev) => new Set(prev).add(profileId));
        social.toast("Davet gönderildi.");
      } else {
        social.toast(res.error ?? "Davet gönderilemedi.");
      }
    },
    [invitedIds, sendingId, roomCode, mode, roomUrl, social]
  );

  // Ekli olmayan oyuncuya arkadaşlık isteği (send_friend_request) — oda daveti DEĞİL.
  const addFriend = useCallback(
    async (r: SearchProfileResult) => {
      if (addingId || r.relationshipStatus !== "none") return;
      setAddingId(r.profileId);
      const res = await sendFriendRequest(r.profileId);
      setAddingId(null);
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
    },
    [addingId, social]
  );

  // Bölüm görünürlükleri (arama aktifken).
  const showFriendsSection = visibleFriends.length > 0;
  // "Oyuncular": sonuç varsa, aranıyorsa ya da hiç arkadaş eşleşmesi yoksa göster
  // (arkadaş eşleşmesi varken boş "bulunamadı" bloğunu gizleyerek kalabalığı azalt).
  const showPlayersSection =
    searchActive && (players.length > 0 || searching || !showFriendsSection);
  // 1 karakter yazıp arkadaş eşleşmesi de yoksa (oyuncu araması henüz tetiklenmedi).
  const noMatchShort = !!q && !searchActive && !showFriendsSection;

  return (
    <>
      <div className="lobby-invite-bar">
        <button
          type="button"
          className={"lobby-invite-btn lobby-invite-btn--copy" + (copied ? " is-copied" : "")}
          onClick={copyLink}
        >
          {copied ? (
            "✓ Kopyalandı"
          ) : copyButtonIcon ? (
            <>
              <span className="lobby-invite-btn-icon" aria-hidden="true">{copyButtonIcon}</span>
              <span>Linki Kopyala</span>
            </>
          ) : (
            "📋 Linki Kopyala"
          )}
        </button>
        <button
          type="button"
          className="lobby-invite-btn lobby-invite-btn--friends"
          onClick={openPicker}
        >
          {friendsButtonIcon ? (
            <>
              <span className="lobby-invite-btn-icon" aria-hidden="true">{friendsButtonIcon}</span>
              <span>Arkadaş Davet Et</span>
            </>
          ) : (
            "👥 Arkadaş Davet Et"
          )}
        </button>
      </div>

      {pickerOpen && (
        <div
          className={`ppc-overlay${isMobile ? " ppc-overlay--sheet" : ""}`}
          onClick={closePicker}
          role="presentation"
        >
          <div className="ppc-overlay-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="ppc-close" onClick={closePicker} aria-label="Kapat">
              ×
            </button>
            <div className="ppc-card lobby-invite-picker" role="dialog" aria-label="Arkadaş davet et">
              <h3 className="lobby-invite-picker-title">Arkadaş Davet Et</h3>

              {!loading && (
                <div className="friends-search friends-search--invite">
                  <span className="friends-search-icon" aria-hidden="true">🔍</span>
                  <input
                    type="text"
                    className="friends-search-input"
                    placeholder="Arkadaş veya oyuncu ara"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Arkadaş veya oyuncu ara"
                  />
                  {search && (
                    <button
                      type="button"
                      className="friends-search-clear"
                      onClick={() => setSearch("")}
                      aria-label="Aramayı temizle"
                    >
                      ×
                    </button>
                  )}
                </div>
              )}

              {loading ? (
                <div className="notif-empty">Yükleniyor…</div>
              ) : !q ? (
                /* Boş arama: tüm arkadaş listesi (ya da hiç arkadaş yoksa boş durum). */
                friends.length === 0 ? (
                  <div className="friends-empty">
                    <span className="friends-empty-title">Henüz arkadaşın yok.</span>
                    <span className="friends-empty-sub">
                      Oyuncu adı veya profil kodu arayarak arkadaş ekleyebilirsin.
                    </span>
                  </div>
                ) : (
                  <div className="lobby-invite-list">
                    {friends.map((f) => (
                      <FriendInviteRow
                        key={f.profileId}
                        friend={f}
                        invited={invitedIds.has(f.profileId)}
                        sending={sendingId === f.profileId}
                        onInvite={() => void invite(f.profileId)}
                      />
                    ))}
                  </div>
                )
              ) : (
                /* Arama aktif: Arkadaşlar + Oyuncular bölümleri. */
                <div className="lobby-invite-sections">
                  {showFriendsSection && (
                    <section className="lobby-invite-section">
                      <div className="lobby-invite-section-label">Arkadaşlar</div>
                      <div className="lobby-invite-list">
                        {visibleFriends.map((f) => (
                          <FriendInviteRow
                            key={f.profileId}
                            friend={f}
                            invited={invitedIds.has(f.profileId)}
                            sending={sendingId === f.profileId}
                            onInvite={() => void invite(f.profileId)}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {showPlayersSection && (
                    <section className="lobby-invite-section">
                      <div className="lobby-invite-section-label">Oyuncular</div>
                      {searching ? (
                        <div className="notif-empty">Aranıyor…</div>
                      ) : players.length === 0 ? (
                        <div className="friends-empty">
                          <span className="friends-empty-title">Eşleşen oyuncu bulunamadı.</span>
                        </div>
                      ) : (
                        <div className="lobby-invite-list">
                          {players.map((r) => {
                            const rel = relationLabel(r.relationshipStatus);
                            const adding = addingId === r.profileId;
                            return (
                              <div key={r.profileId} className="friend-row friend-search-row lobby-invite-row">
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
                                  disabled={rel.disabled || adding}
                                >
                                  {adding ? "Gönderiliyor…" : rel.label}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  )}

                  {noMatchShort && (
                    <div className="friends-empty">
                      <span className="friends-empty-title">Eşleşen oyuncu bulunamadı.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Arkadaş satırı + oda daveti butonu (boş arama ve "Arkadaşlar" bölümünde ortak). */
function FriendInviteRow({
  friend: f,
  invited,
  sending,
  onInvite,
}: {
  friend: FriendRow;
  invited: boolean;
  sending: boolean;
  onInvite: () => void;
}) {
  return (
    <div className="friend-row lobby-invite-row">
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
      <button
        type="button"
        className={"lobby-invite-send" + (invited ? " is-invited" : "")}
        onClick={onInvite}
        disabled={invited || sending}
      >
        {invited ? "Davet Gönderildi" : sending ? "Gönderiliyor…" : "Davet Et"}
      </button>
    </div>
  );
}
