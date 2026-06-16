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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import {
  getPublicProfile,
  sendFriendRequest,
  sendRoomInvite,
  type PublicProfile,
} from "../lib/social";
import { useSocialOptional } from "./SocialContext";
import { PlayerProfileCard } from "./PlayerProfileCard";

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
  const { isMobile } = useIsMobile();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setProfile(null);
  }, []);

  const handleOpen = useCallback(async () => {
    if (!profileId) return;
    setOpen(true);
    setLoading(true);
    const p = await getPublicProfile(profileId);
    setProfile(p);
    setLoading(false);
  }, [profileId]);

  // ESC kapatma
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

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

      {open && (
        <div
          className={`ppc-overlay${isMobile ? " ppc-overlay--sheet" : ""}`}
          onClick={close}
          role="presentation"
        >
          <div className="ppc-overlay-inner" onClick={(e) => e.stopPropagation()}>
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
                showcasedBadgeIds={profile.showcasedBadgeIds}
                frameId={profile.activeAvatarFrameId}
                isSelf={isSelf}
                relationshipStatus={profile.relationshipStatus}
                canInvite={!!social?.roomContext}
                onAddFriend={handleAddFriend}
                onInvite={handleInvite}
                onEditProfile={() => {
                  close();
                  social?.onEditProfile?.();
                }}
                onEditBadges={() => {
                  close();
                  social?.onShowcaseBadges?.();
                }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
