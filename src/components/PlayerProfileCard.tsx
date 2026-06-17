/**
 * PlayerProfileCard.tsx — yatay/dikdörtgen oyuncu profil kartı (v2).
 *
 * Salt sunum bileşeni: veriyi PlayerProfileTrigger çeker (get_public_profile),
 * bu bileşen yalnızca gösterir + aksiyon callback'lerini tetikler.
 *
 * Yapı (desktop'ta yatay/dikdörtgen, mobilde dikey stack):
 *   - HERO: solda büyük avatar (kozmetik çerçeve wrapper'ı), sağda kimlik
 *       · @kullanıcı adı (kozmetik isim rengi uygulanır)
 *       · unvan (kozmetik — yoksa gizli)
 *       · Seviye rozeti + XP barı (mevcut-level içi ilerleme / span)
 *   - ROZET VİTRİNİ (prestij alanı):
 *       · Kendi profilim → 5 düzenlenebilir slot (boşlar "+", tıklanınca editör)
 *       · Başka oyuncu   → yalnız sergilenen rozetler (boş slot gösterilmez)
 *   - MİNİ İSTATİSTİKLER: 4 kutu — 🏆 Galibiyet / 🎮 Maç / 🔥 Seri / 🎖 Başarım
 *       (NATIVE EMOJI — bilerek SVG'ye çevrilmez; Fluent ikon sistemine dokunulmaz)
 *   - AKSİYONLAR:
 *       · Kendi profilim → Profili Düzenle
 *       · Başka oyuncu   → Arkadaş Ekle (duruma göre) / Davet Et /
 *                          Arkadaşlıktan Çıkar / Engelle (veya Engeli Kaldır)
 *
 * GOLD GÖSTERİLMEZ (public kart). Premium koyu-mavi cam oyun stili (.ppc-*).
 * Kozmetik: kart teması (data-theme), efekt (data-effect), isim rengi, unvan,
 * çerçeve — şu an yalnız default değerler aktif (bkz. lib/cosmetics.ts).
 * Rozet ipuçları CSS tooltip (data-tip). Desktop/mobil/native ortak.
 */
import { getAvatar } from "../data/avatars";
import { getLevelProgress } from "../lib/progression";
import {
  resolveCardEffectKey,
  resolveCardThemeKey,
  resolveFrameId,
  resolveNameColor,
  resolveTitleText,
} from "../lib/cosmetics";
import { PlayerAvatar } from "./PlayerAvatar";
import type { RelationshipStatus } from "../lib/social";

const BADGE_SLOTS = 5;

interface PlayerProfileCardProps {
  username: string | null;
  avatarId: string | null;
  level: number;
  /** Toplam XP — XP barı için. null/undefined → bar gizlenir (graceful fallback). */
  xp?: number | null;
  /** Mini istatistikler — null/undefined → "—" gösterilir (uydurma veri yok). */
  winsCount?: number | null;
  matchesCount?: number | null;
  currentStreak?: number | null;
  achievementsCount?: number | null;
  /** En fazla 5 sergilenen rozet/achievement tier id'si. */
  showcasedBadgeIds: string[];

  /** Kozmetik seçimleri (default null → default görünüm). */
  frameId?: string | null;
  cardThemeId?: string | null;
  nameColorId?: string | null;
  titleId?: string | null;
  effectId?: string | null;

  isSelf: boolean;
  relationshipStatus: RelationshipStatus;

  /** Başka oyuncu aksiyonları. */
  onAddFriend?: () => void;
  onInvite?: () => void;
  onBlock?: () => void;
  /** Arkadaşlıktan çıkar (yalnız status === "friends"). */
  onRemoveFriend?: () => void;
  /** Engeli kaldır (yalnız status === "blocked"). */
  onUnblock?: () => void;
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

/** İstatistik değerini biçimler; veri yoksa "—" (uydurma sayı gösterilmez). */
function statValue(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.max(0, Math.floor(n)).toLocaleString("tr-TR");
}

interface StatTileProps {
  /** NATIVE emoji — SVG değil (kasıtlı). */
  emoji: string;
  value: number | null | undefined;
  label: string;
}

function StatTile({ emoji, value, label }: StatTileProps) {
  return (
    <div className="ppc-stat">
      <span className="ppc-stat-emoji" aria-hidden="true">
        {emoji}
      </span>
      <span className="ppc-stat-value">{statValue(value)}</span>
      <span className="ppc-stat-label">{label}</span>
    </div>
  );
}

export function PlayerProfileCard({
  username,
  avatarId,
  level,
  xp,
  winsCount,
  matchesCount,
  currentStreak,
  achievementsCount,
  showcasedBadgeIds,
  frameId,
  cardThemeId,
  nameColorId,
  titleId,
  effectId,
  isSelf,
  relationshipStatus,
  onAddFriend,
  onInvite,
  onBlock,
  onRemoveFriend,
  onUnblock,
  canInvite,
  onEditProfile,
  onEditBadges,
}: PlayerProfileCardProps) {
  const friendBtn = friendButtonLabel(relationshipStatus);
  const isBlocked = relationshipStatus === "blocked";
  const isFriend = relationshipStatus === "friends";

  // Başka oyuncu: yalnız gerçek (çözülebilen) rozetleri göster — boş slot yok.
  const otherBadges = showcasedBadgeIds.filter((id) => getAvatar(id));
  // Kendi profilim: 5 slot (dolu rozetler + boş "+" placeholder'lar).
  const selfSlots = Array.from({ length: BADGE_SLOTS }, (_, i) => showcasedBadgeIds[i] ?? null);
  const showBadges = isSelf || otherBadges.length > 0;

  // XP barı: yalnızca gerçek XP verisi varsa. getLevelProgress level-içi ilerlemeyi verir.
  const hasXp = xp != null && Number.isFinite(xp);
  const prog = hasXp ? getLevelProgress(xp as number) : null;
  const xpSpan = prog ? Math.max(0, prog.nextLevelXp - prog.currentLevelXp) : 0;

  // Kozmetik çözümleme (default null → default görünüm).
  const themeKey = resolveCardThemeKey(cardThemeId);
  const effectKey = resolveCardEffectKey(effectId);
  const nameColor = resolveNameColor(nameColorId);
  const titleText = resolveTitleText(titleId);
  const resolvedFrame = resolveFrameId(frameId);

  return (
    <div
      className="ppc-card"
      data-theme={themeKey}
      data-effect={effectKey}
      role="dialog"
      aria-label="Oyuncu profili"
    >
      {/* HERO: avatar + kimlik */}
      <div className="ppc-hero">
        <div className="ppc-avatar-wrap">
          <PlayerAvatar avatarId={avatarId} username={username} size="lg" frameId={resolvedFrame} />
        </div>
        <div className="ppc-identity">
          <span
            className="ppc-uname"
            style={nameColor ? { color: nameColor } : undefined}
          >
            @{username ?? "—"}
          </span>
          {titleText && <span className="ppc-title-tag">{titleText}</span>}

          <div className="ppc-level-row">
            <span className="ppc-level">Seviye {level}</span>
            {prog && (
              <span className="ppc-xp-label">
                {prog.xpIntoLevel.toLocaleString("tr-TR")} / {xpSpan.toLocaleString("tr-TR")} XP
              </span>
            )}
          </div>

          {prog && (
            <div
              className="ppc-xp-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={xpSpan}
              aria-valuenow={prog.xpIntoLevel}
              aria-label="Seviye ilerlemesi"
            >
              <div className="ppc-xp-fill" style={{ width: `${Math.round(prog.progressRatio * 100)}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* ROZET VİTRİNİ */}
      {showBadges && (
        <div className="ppc-section">
          <span className="ppc-section-label">Rozetler</span>
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
          )}
        </div>
      )}

      {/* MİNİ İSTATİSTİKLER (native emoji) */}
      <div className="ppc-section">
        <span className="ppc-section-label">İstatistikler</span>
        <div className="ppc-stats">
          <StatTile emoji="🏆" value={winsCount} label="Galibiyet" />
          <StatTile emoji="🎮" value={matchesCount} label="Maç" />
          <StatTile emoji="🔥" value={currentStreak} label="Seri" />
          <StatTile emoji="🎖️" value={achievementsCount} label="Başarım" />
        </div>
      </div>

      {/* AKSİYONLAR */}
      <div className="ppc-actions">
        {isSelf ? (
          <button type="button" className="ppc-btn ppc-btn--primary" onClick={onEditProfile}>
            Profili Düzenle
          </button>
        ) : isBlocked ? (
          <>
            <button type="button" className="ppc-btn" disabled>
              Engellendi
            </button>
            <button type="button" className="ppc-btn ppc-btn--primary" onClick={onUnblock}>
              Engeli Kaldır
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
            {isFriend && (
              <button type="button" className="ppc-btn" onClick={onRemoveFriend}>
                Arkadaşlıktan Çıkar
              </button>
            )}
            <button type="button" className="ppc-btn ppc-btn--danger" onClick={onBlock}>
              Engelle
            </button>
          </>
        )}
      </div>
    </div>
  );
}
