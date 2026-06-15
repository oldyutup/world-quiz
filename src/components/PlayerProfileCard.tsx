/**
 * PlayerProfileCard.tsx — hızlı public profil önizlemesi.
 *
 * Salt sunum bileşeni: veriyi PlayerProfileTrigger çeker (get_public_profile),
 * bu bileşen yalnızca gösterir + aksiyon callback'lerini tetikler.
 *
 * İçerik:
 *   - Büyük yuvarlak avatar (çerçeve wrapper'ı ileri kozmetik için hazır)
 *   - @kullanıcı adı, Seviye, XP
 *   - 5 rozet sergileme slotu (boşlar silik placeholder)
 *   - Kendi profilim → Profili Düzenle / Avatarı Değiştir
 *   - Başka oyuncu → Arkadaş Ekle (duruma göre etiket) / Davet Et / Engelle
 *
 * GOLD GÖSTERİLMEZ (public kart). Premium koyu-cam oyun stili (.ppc-*).
 * Desktop/mobil/native ortak; kapsayıcı overlay'i Trigger yönetir.
 */
import { getAvatar } from "../data/avatars";
import { PlayerAvatar } from "./PlayerAvatar";
import type { RelationshipStatus } from "../lib/social";

const BADGE_SLOTS = 5;

interface PlayerProfileCardProps {
  username: string | null;
  avatarId: string | null;
  level: number;
  /** Toplam XP (opsiyonel — public kartta yalnızca seviye zorunlu). */
  xp?: number | null;
  /** En fazla 5 sergilenen rozet/achievement tier id'si. */
  showcasedBadgeIds: string[];
  frameId?: string | null;

  isSelf: boolean;
  relationshipStatus: RelationshipStatus;

  /** Başka oyuncu aksiyonları. */
  onAddFriend?: () => void;
  onInvite?: () => void;
  onBlock?: () => void;
  /** Davet edilebilir mi (aktif oda context'i var mı). */
  canInvite?: boolean;

  /** Kendi profil aksiyonları. */
  onEditProfile?: () => void;
  onChangeAvatar?: () => void;
}

function friendButtonLabel(status: RelationshipStatus): { label: string; disabled: boolean } {
  switch (status) {
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

export function PlayerProfileCard({
  username,
  avatarId,
  level,
  xp,
  showcasedBadgeIds,
  frameId,
  isSelf,
  relationshipStatus,
  onAddFriend,
  onInvite,
  onBlock,
  canInvite,
  onEditProfile,
  onChangeAvatar,
}: PlayerProfileCardProps) {
  const friendBtn = friendButtonLabel(relationshipStatus);

  // 5 slot: dolu rozetler + boş placeholder'lar.
  const slots = Array.from({ length: BADGE_SLOTS }, (_, i) => showcasedBadgeIds[i] ?? null);

  return (
    <div className="ppc-card" role="dialog" aria-label="Oyuncu profili">
      <div className="ppc-head">
        <PlayerAvatar avatarId={avatarId} username={username} size="lg" frameId={frameId} />
        <div className="ppc-identity">
          <span className="ppc-uname">@{username ?? "—"}</span>
          <div className="ppc-meta">
            <span className="ppc-level">Seviye {level}</span>
            {xp != null && <span className="ppc-xp">{xp.toLocaleString("tr-TR")} XP</span>}
          </div>
        </div>
      </div>

      {/* Rozet vitrini — 5 slot (kozmetik altyapısı; seçim ekranı ileride). */}
      <div className="ppc-badges" aria-label="Sergilenen rozetler">
        {slots.map((badgeId, i) => {
          const def = badgeId ? getAvatar(badgeId) : null;
          return (
            <span
              key={i}
              className={`ppc-badge-slot${badgeId ? " ppc-badge-slot--filled" : " ppc-badge-slot--empty"}`}
              title={def?.label ?? "Boş rozet slotu"}
            >
              {def ? <img src={def.image} alt={def.label} className="ppc-badge-img" /> : null}
            </span>
          );
        })}
      </div>

      {/* Aksiyonlar */}
      <div className="ppc-actions">
        {isSelf ? (
          <>
            <button type="button" className="ppc-btn ppc-btn--primary" onClick={onEditProfile}>
              Profili Düzenle
            </button>
            <button type="button" className="ppc-btn" onClick={onChangeAvatar}>
              Avatarı Değiştir
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ppc-btn ppc-btn--primary"
              onClick={onAddFriend}
              disabled={friendBtn.disabled}
            >
              {friendBtn.label}
            </button>
            <button
              type="button"
              className="ppc-btn"
              onClick={onInvite}
              disabled={!canInvite}
              title={canInvite ? undefined : "Bir odadayken davet gönderebilirsin."}
            >
              Davet Et
            </button>
            <button
              type="button"
              className="ppc-btn ppc-btn--ghost"
              onClick={onBlock}
              disabled
              title="Engelleme sistemi yakında"
            >
              Engelle
            </button>
          </>
        )}
      </div>
    </div>
  );
}
