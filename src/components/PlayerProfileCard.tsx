/**
 * PlayerProfileCard.tsx — hızlı public profil önizlemesi.
 *
 * Salt sunum bileşeni: veriyi PlayerProfileTrigger çeker (get_public_profile),
 * bu bileşen yalnızca gösterir + aksiyon callback'lerini tetikler.
 *
 * İçerik:
 *   - Büyük yuvarlak avatar (çerçeve wrapper'ı ileri kozmetik için hazır)
 *   - @kullanıcı adı, Seviye, XP
 *   - Rozet vitrini:
 *       · Kendi profilim → 5 düzenlenebilir slot (boşlar "+", tıklanınca editör)
 *       · Başka oyuncu   → yalnız sergilenen rozetler (boş slot gösterilmez)
 *   - Kendi profilim → tek aksiyon: Profili Düzenle (merkezi modal)
 *   - Başka oyuncu   → Arkadaş Ekle (duruma göre etiket) / Davet Et / Engelle
 *
 * GOLD GÖSTERİLMEZ (public kart). Premium koyu-cam oyun stili (.ppc-*). Rozet
 * ipuçları native title yerine CSS tooltip (data-tip) ile gösterilir (konum
 * sorunu giderildi). Desktop/mobil/native ortak; kapsayıcı overlay'i Trigger
 * yönetir.
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
  /** Rozet slotuna tıklayınca doğrudan sergileme editörünü açar (yalnız self). */
  onEditBadges?: () => void;
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
  onEditBadges,
}: PlayerProfileCardProps) {
  const friendBtn = friendButtonLabel(relationshipStatus);

  // Başka oyuncu: yalnız gerçek (çözülebilen) rozetleri göster — boş slot yok.
  const otherBadges = showcasedBadgeIds.filter((id) => getAvatar(id));
  // Kendi profilim: 5 slot (dolu rozetler + boş "+" placeholder'lar).
  const selfSlots = Array.from({ length: BADGE_SLOTS }, (_, i) => showcasedBadgeIds[i] ?? null);

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

      {/* Rozet vitrini */}
      {isSelf ? (
        <div className="ppc-badges ppc-badges--self" aria-label="Sergilenen rozetler">
          {selfSlots.map((badgeId, i) => {
            const def = badgeId ? getAvatar(badgeId) : null;
            return (
              <button
                key={i}
                type="button"
                className={`ppc-badge-slot ppc-badge-slot--btn${
                  def ? " ppc-badge-slot--filled" : " ppc-badge-slot--empty"
                }`}
                onClick={onEditBadges}
                data-tip={def?.label ?? "Rozet ekle"}
                aria-label={def?.label ?? "Rozet ekle"}
              >
                {def ? (
                  <img src={def.image} alt={def.label} className="ppc-badge-img" />
                ) : (
                  <span className="ppc-badge-plus" aria-hidden="true">
                    +
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        otherBadges.length > 0 && (
          <div className="ppc-badges" aria-label="Sergilenen rozetler">
            {otherBadges.map((badgeId, i) => {
              const def = getAvatar(badgeId);
              return (
                <span
                  key={i}
                  className="ppc-badge-slot ppc-badge-slot--filled"
                  data-tip={def?.label}
                >
                  {def ? <img src={def.image} alt={def.label} className="ppc-badge-img" /> : null}
                </span>
              );
            })}
          </div>
        )
      )}

      {/* Aksiyonlar */}
      <div className="ppc-actions">
        {isSelf ? (
          <button type="button" className="ppc-btn ppc-btn--primary" onClick={onEditProfile}>
            Profili Düzenle
          </button>
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
