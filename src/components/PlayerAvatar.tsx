/**
 * PlayerAvatar.tsx — ortak oyuncu avatarı.
 *
 * Mevcut Avatar.tsx renderer'ını sarar; üstüne sosyal/oyun UI'ında ihtiyaç
 * duyulan iki şeyi ekler:
 *   1) `size` ön ayarları (sm / md / lg) — leaderboard satırı, lobi satırı,
 *      profil kartı için tutarlı çaplar. Sayısal px de geçilebilir.
 *   2) `frameId` wrapper — kozmetik avatar çerçevesi sistemine HAZIR. Çerçeve
 *      henüz aktif değilse (frameId yok / bilinmiyor) görsel olarak nötr bir
 *      wrapper'dır; ileride satın alınan çerçeve geldiğinde sadece bu katman
 *      stillenir, çağıran kod değişmez.
 *
 * Avatar daima dairesel ve object-fit:cover (CSS .player-avatar-img). Bilinmeyen
 * / null avatar Avatar.tsx içinde default dünya görseline düşer.
 *
 * Desktop web, mobil web ve native iOS/app'te aynı bileşendir.
 */
import { Avatar } from "./Avatar";

export type PlayerAvatarSize = "sm" | "md" | "lg";

const SIZE_PX: Record<PlayerAvatarSize, number> = {
  sm: 32, // leaderboard / lobi satırı (28–34 aralığı)
  md: 48, // dropdown / orta
  lg: 92, // profil kartı başlık avatarı
};

interface PlayerAvatarProps {
  avatarId?: string | null;
  username?: string | null;
  /** Ön ayar boyutu (sm/md/lg) ya da doğrudan px. Varsayılan "sm". */
  size?: PlayerAvatarSize | number;
  /** Kozmetik çerçeve id'si — şimdilik wrapper'a data attribute olarak yazılır
   *  (frame sistemi aktif değilse görsel etki yok). */
  frameId?: string | null;
  /** Ek vurgu (ör. leaderboard ilk 3, lobi host). */
  highlight?: boolean;
  className?: string;
  title?: string;
}

export function PlayerAvatar({
  avatarId,
  username,
  size = "sm",
  frameId,
  highlight,
  className,
  title,
}: PlayerAvatarProps) {
  const px = typeof size === "number" ? size : SIZE_PX[size];

  return (
    <span
      className={`player-avatar${highlight ? " player-avatar--highlight" : ""}${
        frameId ? " player-avatar--framed" : ""
      }${className ? ` ${className}` : ""}`}
      style={{ width: px, height: px }}
      data-frame={frameId ?? undefined}
      title={title}
    >
      <Avatar
        avatarId={avatarId}
        username={username}
        size={px}
        className="player-avatar-img"
      />
    </span>
  );
}
