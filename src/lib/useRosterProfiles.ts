/**
 * useRosterProfiles — bir lobi/oda roster'ındaki profil id'leri için avatar +
 * username + level bilgisini TEK çağrıda çözer (get_public_profiles RPC).
 *
 * Lobi player satırları yalnız profile_id taşır; avatar_id taşımaz. Bu hook id
 * kümesi değiştiğinde (oyuncu girdi/çıktı) tek batched RPC atar — N+1 YOK,
 * 1000+ oyunculu gelecek için de güvenli (oda kapasiteleri zaten küçük).
 *
 * KENDİ KAYDIM CANLI: RPC yalnız id kümesi değişince koşar. Kullanıcı lobide
 * profilini düzenleyip avatarını/adını değiştirdiğinde id kümesi değişmez →
 * RPC tekrar koşmaz → kendi satırı stale kalırdı. Bunu önlemek için, Social
 * context'teki canlı oturum profili (App `setProfile` ile güncellenir) kendi
 * roster kaydının ÜZERİNE bindirilir. Böylece tüm lobi türlerinde (Çark 1v1/
 * grup, Kuşatma, Kör Nokta, Bayrak, Duel…) kendi avatar/ad/level değişimi anında
 * yansır — yeniden fetch, polling, presence reconnect veya re-join OLMADAN.
 *
 * Dönüş: profileId → { avatarId, username, level } map'i. Guest satırlar
 * (profile_id null) çağrıdan dışlanır; map'te bulunmaz, çağıran default avatara düşer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getPublicProfiles, type PublicProfileLite } from "./social";
import { useSocialOptional } from "../components/SocialContext";

export function useRosterProfiles(
  profileIds: (string | null | undefined)[]
): Map<string, PublicProfileLite> {
  const [map, setMap] = useState<Map<string, PublicProfileLite>>(new Map());
  const lastKey = useRef<string>("");

  // Sıralamadan bağımsız stabil anahtar: aynı id kümesi → tekrar fetch yok.
  const ids = Array.from(new Set(profileIds.filter((x): x is string => !!x))).sort();
  const key = ids.join(",");

  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (ids.length === 0) {
      setMap(new Map());
      return;
    }
    let alive = true;
    void getPublicProfiles(ids).then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
    // key id kümesini temsil eder; ids referansı her render değişse de içerik aynıysa no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Canlı oturum profili (avatar/ad/level değiştikçe güncellenir). Provider
  // dışında (ör. izole test) null → bindirme yapılmaz, RPC sonucu aynen döner.
  const self = useSocialOptional()?.profile ?? null;

  // Yalnız GÖRSEL bindirme: kendi kaydım bu roster'da varsa, fetch edilen
  // değerin üzerine canlı profili yaz (yeni nesne → React re-render alır).
  // Çerçeve (activeAvatarFrameId) Profile'da yok → fetch edilen değer korunur.
  return useMemo(() => {
    if (!self?.id || !map.has(self.id)) return map;
    const merged = new Map(map);
    const existing = merged.get(self.id);
    merged.set(self.id, {
      profileId: self.id,
      username: self.username ?? existing?.username ?? null,
      avatarId: self.avatar_id ?? existing?.avatarId ?? null,
      level: self.level ?? existing?.level ?? 1,
      activeAvatarFrameId: existing?.activeAvatarFrameId ?? null,
    });
    return merged;
  }, [map, self?.id, self?.username, self?.avatar_id, self?.level]);
}
