/**
 * useRosterProfiles — bir lobi/oda roster'ındaki profil id'leri için avatar +
 * username + level bilgisini TEK çağrıda çözer (get_public_profiles RPC).
 *
 * Lobi player satırları yalnız profile_id taşır; avatar_id taşımaz. Bu hook id
 * kümesi değiştiğinde (oyuncu girdi/çıktı) tek batched RPC atar — N+1 YOK,
 * 1000+ oyunculu gelecek için de güvenli (oda kapasiteleri zaten küçük).
 *
 * Dönüş: profileId → { avatarId, username, level } map'i. Guest satırlar
 * (profile_id null) çağrıdan dışlanır; map'te bulunmaz, çağıran default avatara düşer.
 */
import { useEffect, useRef, useState } from "react";
import { getPublicProfiles, type PublicProfileLite } from "./social";

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

  return map;
}
