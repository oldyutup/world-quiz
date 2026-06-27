/**
 * PlayerProfileTrigger.tsx — oyuncu adına/avatarına tıklayınca public profil
 * kartını açan sarmalayıcı.
 *
 * children'ı tıklanabilir yapar; tıklanınca get_public_profile ile veriyi çeker
 * ve PlayerProfileCard'ı bir overlay içinde gösterir:
 *   - Desktop: ortalı modal (cam panel)
 *   - Mobil web / native: bottom-sheet (safe-area korunur)
 * Dışarı tık + ESC ile kapanır.
 *
 * Aksiyonlar SocialContext üzerinden yürür (arkadaş ekle / davet / self düzenle).
 * Guest oyuncularda (profileId yok) tıklama no-op'tur — kart açılmaz.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "../lib/useIsMobile";
import {
  blockUser,
  getPublicProfile,
  removeFriend,
  sendFriendRequest,
  sendRoomInvite,
  unblockUser,
  type PublicProfile,
} from "../lib/social";
import { useSocialOptional } from "./SocialContext";
import { useDmOptional } from "./DmContext";
import { PlayerProfileCard } from "./PlayerProfileCard";
import { ConfirmDialog } from "./ConfirmDialog";

interface PlayerProfileTriggerProps {
  /** Hedef oyuncunun profil id'si. null/undefined → guest, tıklama no-op. */
  profileId: string | null | undefined;
  children: ReactNode;
  className?: string;
  /** Sarmalayıcı etiketi: tıklanabilir bir <button> (varsayılan) ya da span. */
  as?: "button" | "span";
}

export function PlayerProfileTrigger({
  profileId,
  children,
  className,
  as = "button",
}: PlayerProfileTriggerProps) {
  const social = useSocialOptional();
  const dm = useDmOptional();
  const { isMobile } = useIsMobile();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  /** Onay diyaloğu: arkadaşlıktan çıkar veya engelle. */
  const [confirmKind, setConfirmKind] = useState<null | "remove" | "block">(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    setProfile(null);
    setConfirmKind(null);
    setBusy(false);
  }, []);

  const handleOpen = useCallback(async () => {
    if (!profileId) return;
    setOpen(true);
    setLoading(true);
    const p = await getPublicProfile(profileId);
    setProfile(p);
    setLoading(false);
  }, [profileId]);

  // Kendi profilimi düzenleme modalı bu kartın ÜSTÜNDE açılır (z6100 > kart
  // z1200). Açıkken kartın ESC'sini bastırırız ki ESC önce üstteki editörü
  // kapatsın, kartı değil. Ref ile canlı okuruz (dinleyiciyi yeniden kurmadan).
  const editorOpenRef = useRef(false);
  editorOpenRef.current = !!social?.profileEditorOpen;

  // ESC kapatma (üstte editör açıkken devre dışı)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editorOpenRef.current) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Editör kapanınca (true→false) açık kendi kartımı tazele: kaydedilen avatar /
  // kullanıcı adı / seviye / rozetler kartta anında görünsün. Kart açık değilse
  // veya başkasının kartıysa no-op.
  const prevEditorOpenRef = useRef(false);
  useEffect(() => {
    const editorOpen = !!social?.profileEditorOpen;
    const justClosed = prevEditorOpenRef.current && !editorOpen;
    prevEditorOpenRef.current = editorOpen;
    if (!justClosed || !open || !profileId) return;
    if (profile?.relationshipStatus !== "self") return;
    void (async () => {
      const p = await getPublicProfile(profileId);
      if (p) setProfile(p);
    })();
  }, [social?.profileEditorOpen, open, profileId, profile?.relationshipStatus]);

  const handleAddFriend = useCallback(async () => {
    if (!profileId) return;
    const res = await sendFriendRequest(profileId);
    if (res.ok) {
      social?.toast("Arkadaşlık isteği gönderildi.");
      setProfile((prev) => (prev ? { ...prev, relationshipStatus: "request_sent" } : prev));
    } else {
      social?.toast(res.error ?? "İstek gönderilemedi.");
    }
  }, [profileId, social]);

  const handleInvite = useCallback(async () => {
    if (!profileId || !social?.roomContext) return;
    const { code, mode, roomUrl } = social.roomContext;
    const res = await sendRoomInvite({ recipientProfileId: profileId, roomCode: code, mode, roomUrl });
    social.toast(res.ok ? "Oyun daveti gönderildi." : res.error ?? "Davet gönderilemedi.");
  }, [profileId, social]);

  // Mesaj (DM) — yalnız mobil/native profil yüzeyinde gösterilir (desktop'ta DM
  // girişi arkadaşlar panelindedir, kart değişmez). Mevcut DM sistemini kullanır:
  // önce profil sheet'ini KAPAT (çakışan sheet/modal kalmasın) → sonra global DM
  // modalını aç. Konuşma yoksa mevcut web mantığıyla (getOrCreateConversation)
  // başlatılır; varsa o açılır. Sohbet kapanınca kullanıcı arkasındaki sosyal
  // bağlama (arkadaş listesi sheet'i / önceki yüzey) döner. Buton yalnız
  // arkadaşken render edilir (bkz. PlayerProfileCard) → web kuralıyla aynı.
  const handleMessage = useCallback(() => {
    if (!profile || !profileId) return;
    close();
    dm?.openChatWith({
      profileId,
      username: profile.username,
      avatarId: profile.avatarId,
      frameId: profile.activeAvatarFrameId,
    });
  }, [profile, profileId, close, dm]);

  // Engeli kaldırma onay gerektirmez (geri-dönüşlü, düşük riskli aksiyon).
  const handleUnblock = useCallback(async () => {
    if (!profileId) return;
    const res = await unblockUser(profileId);
    if (res.ok) {
      social?.toast("Engel kaldırıldı.");
      setProfile((prev) => (prev ? { ...prev, relationshipStatus: "none" } : prev));
    } else {
      social?.toast("Engel kaldırılamadı, tekrar dene.");
    }
  }, [profileId, social]);

  // Onay diyaloğundaki "Onayla" → arkadaşlıktan çıkar veya engelle.
  const handleConfirm = useCallback(async () => {
    if (!profileId || !confirmKind) return;
    setBusy(true);
    if (confirmKind === "remove") {
      const res = await removeFriend(profileId);
      if (res.ok) {
        social?.toast("Arkadaşlıktan çıkarıldı.");
        social?.bumpFriends();
        setProfile((prev) => (prev ? { ...prev, relationshipStatus: "none" } : prev));
      } else {
        social?.toast("İşlem tamamlanamadı, tekrar dene.");
      }
    } else {
      const res = await blockUser(profileId);
      if (res.ok) {
        social?.toast("Kullanıcı engellendi.");
        social?.bumpFriends();
        setProfile((prev) => (prev ? { ...prev, relationshipStatus: "blocked" } : prev));
      } else {
        social?.toast("Kullanıcı engellenemedi, tekrar dene.");
      }
    }
    setBusy(false);
    setConfirmKind(null);
  }, [profileId, confirmKind, social]);

  const isSelf = profile?.relationshipStatus === "self";
  const Tag = as;

  return (
    <>
      <Tag
        type={as === "button" ? "button" : undefined}
        className={`ppt-trigger${className ? ` ${className}` : ""}`}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void handleOpen();
        }}
        // span varyantında klavye erişimi
        role={as === "span" ? "button" : undefined}
        tabIndex={as === "span" ? 0 : undefined}
        onKeyDown={
          as === "span"
            ? (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void handleOpen();
                }
              }
            : undefined
        }
      >
        {children}
      </Tag>

      {open && createPortal(
        <div
          className={`ppc-overlay${isMobile ? " ppc-overlay--sheet" : ""}`}
          onClick={close}
          role="presentation"
        >
          {/* --card: yalnız profil kartı için geniş varyant. LobbyInviteBar
              aynı .ppc-overlay-inner kabuğunu paylaştığından genişlik global
              değil, bu modifier ile verilir. */}
          <div className="ppc-overlay-inner ppc-overlay-inner--card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="ppc-close" onClick={close} aria-label="Kapat">
              ×
            </button>
            {loading || !profile ? (
              <div className="ppc-loading">{loading ? "Profil yükleniyor…" : "Profil bulunamadı."}</div>
            ) : (
              <PlayerProfileCard
                username={profile.username}
                avatarId={profile.avatarId}
                level={profile.level}
                xp={profile.xp}
                winsCount={profile.winsCount}
                matchesCount={profile.matchesCount}
                currentStreak={profile.currentStreak}
                achievementsCount={profile.achievementsCount}
                showcasedBadgeIds={profile.showcasedBadgeIds}
                frameId={profile.activeAvatarFrameId}
                cardThemeId={profile.activeProfileThemeId}
                nameColorId={profile.activeNameColorId}
                titleId={profile.activeProfileTitleId}
                effectId={profile.activeProfileEffectId}
                isSelf={isSelf}
                relationshipStatus={profile.relationshipStatus}
                canInvite={!!social?.roomContext}
                onAddFriend={handleAddFriend}
                onInvite={handleInvite}
                onMessage={isMobile ? handleMessage : undefined}
                onRemoveFriend={() => setConfirmKind("remove")}
                onBlock={() => setConfirmKind("block")}
                onUnblock={handleUnblock}
                onEditProfile={() => {
                  // Kartı KAPATMA: editör üstte açılır (z6100 > z1200), kapanınca
                  // kullanıcı aynı karta döner. Kart, editör kapanınca tazelenir.
                  social?.onEditProfile?.();
                }}
                onEditBadges={() => {
                  social?.onShowcaseBadges?.();
                }}
              />
            )}
          </div>
        </div>,
        document.body,
      )}

      {confirmKind === "remove" && createPortal(
        <ConfirmDialog
          title="Arkadaşlıktan çıkar?"
          description="Bu kullanıcı arkadaş listenden kaldırılacak."
          confirmLabel="Arkadaşlıktan Çıkar"
          cancelLabel="Vazgeç"
          destructive
          busy={busy}
          onConfirm={() => void handleConfirm()}
          onCancel={() => !busy && setConfirmKind(null)}
        />,
        document.body,
      )}

      {confirmKind === "block" && createPortal(
        <ConfirmDialog
          title="Kullanıcıyı engelle?"
          description="Bu kullanıcı sana istek veya davet gönderemez. Mesajları görünmez. İstersen daha sonra engeli kaldırabilirsin."
          confirmLabel="Engelle"
          cancelLabel="Vazgeç"
          destructive
          busy={busy}
          onConfirm={() => void handleConfirm()}
          onCancel={() => !busy && setConfirmKind(null)}
        />,
        document.body,
      )}
    </>
  );
}
