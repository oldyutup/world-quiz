/**
 * AtlasRankStrip.tsx — ana ekran "Atlas Klasmanı" daveti (desktop).
 *
 * Mod ızgarasının altında TEK satırlık, ghost ağırlıkta bir şerit; tıklanınca
 * mevcut LeaderboardModal açılır (onOpen). Sıralama'nın ana ekrandaki girişi
 * artık budur (eski sağ-üst "Sıralama" butonu kaldırıldı). Yeni ekran/RPC yok:
 *
 *  - Veri: get_xp_leaderboard(p_scope:'general', p_limit:10) — modalla aynı
 *    RPC. Top-3 avatarı gösterilir; giriş yapmış oyuncu ilk 10'daysa "SEN #N"
 *    çipi eklenir (kişisel-sıra RPC'si YOK, bilinçli kapsam dışı).
 *  - Ana sayfa performansı korunur: fetch ilk boyamayı BLOKLAMAZ (kısa idle
 *    gecikmesiyle başlar), sonuç sessionStorage'ta 5 dk cache'lenir, hata /
 *    boş veri durumunda şerit avatarsız-çipsiz hâliyle EKSİKSİZ çalışır
 *    (fail-silent; hata mesajı gösterilmez — modal kendi hatasını yönetir).
 *  - Misafirde de görünür; yalnız "SEN" çipi oturum ister (getSession, yerel).
 *
 * ≤600px'te CSS gizler (mobil ana sayfanın alt-nav'ında kendi Sıralama girişi
 * var); native'te de aynı kural geçerli. Kart/panel DEĞİLDİR ve öyle kalmalı.
 */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Avatar } from "./Avatar";

interface StripLeader {
  profileId: string;
  username: string | null;
  avatarId: string | null;
}
interface StripData {
  leaders: StripLeader[];
  selfRank: number | null;
}

/** get_xp_leaderboard satırı (LeaderboardModal.XpRow ile aynı sözleşme). */
interface XpLeaderboardRow {
  profile_id: string;
  username: string | null;
  avatar_id: string | null;
  xp: number;
  total_xp: number;
  level: number;
}

const CACHE_KEY = "torble_atlas_strip_v1";
const CACHE_TTL_MS = 5 * 60_000;
/** İlk boyamayla yarışmasın: fetch bu kadar ms sonra (idle) başlar. */
const FETCH_DELAY_MS = 900;

function readCache(): StripData | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: number; data?: StripData };
    if (typeof parsed?.t !== "number" || !parsed.data) return null;
    if (Date.now() - parsed.t > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(data: StripData) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {
    /* storage dolu/kapalı olabilir — cache opsiyonel */
  }
}

/* Atlas ikon ailesi (bkz. LeaderboardModal.CompassMark): tek stroke/weight,
   hafif iç dolgu. Renkli emoji yerine bu rafine çizgi dili kullanılır. */
function TrophyMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 4.6h8v3.2a4 4 0 0 1-8 0V4.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <path
        d="M8 6.2H5.6a2.4 2.4 0 0 0 2.6 2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M16 6.2h2.4a2.4 2.4 0 0 1-2.6 2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M12 11.9v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.9 18.4h6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10.5 18.4c0-2 .6-3.5 1.5-3.5s1.5 1.5 1.5 3.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

interface Props {
  /** LeaderboardModal'ı açar (App.tsx setLeaderboardOpen). */
  onOpen: () => void;
}

export function AtlasRankStrip({ onOpen }: Props) {
  const [data, setData] = useState<StripData | null>(() => readCache());

  useEffect(() => {
    if (data) return; // cache tazeydi — ağa hiç çıkma
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          // getSession yereldir (ağ çağrısı yok) — misafirde user=null.
          const [{ data: rows, error }, { data: sess }] = await Promise.all([
            supabase.rpc("get_xp_leaderboard", { p_scope: "general", p_limit: 10 }),
            supabase.auth.getSession(),
          ]);
          if (!alive || error || !Array.isArray(rows) || rows.length === 0) return;
          const typed = rows as XpLeaderboardRow[];
          const leaders = typed.slice(0, 3).map((r) => ({
            profileId: r.profile_id,
            username: r.username,
            avatarId: r.avatar_id,
          }));
          const selfId = sess.session?.user?.id ?? null;
          const idx = selfId ? typed.findIndex((r) => r.profile_id === selfId) : -1;
          const next: StripData = { leaders, selfRank: idx >= 0 ? idx + 1 : null };
          writeCache(next);
          setData(next);
        } catch {
          /* sessiz: şerit avatarsız hâliyle tam çalışır */
        }
      })();
    }, FETCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [data]);

  const leaders = data?.leaders ?? [];

  return (
    <button
      type="button"
      className="atlas-strip"
      onClick={onOpen}
      aria-label="Atlas Klasmanı sıralamasını aç"
    >
      <span className="atlas-strip-rule" aria-hidden="true" />
      <span className="atlas-strip-core">
        <TrophyMark className="atlas-strip-trophy" />
        <span className="atlas-strip-label">Atlas Klasmanı</span>
        {leaders.length > 0 && (
          <span className="atlas-strip-avatars" aria-hidden="true">
            {leaders.map((l) => (
              <Avatar
                key={l.profileId}
                avatarId={l.avatarId}
                username={l.username}
                className="atlas-strip-avatar"
              />
            ))}
          </span>
        )}
        {data?.selfRank != null && (
          <span className="atlas-strip-self">SEN&nbsp;#{data.selfRank}</span>
        )}
        <span className="atlas-strip-open">
          Aç
          <svg className="atlas-strip-open-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
      <span className="atlas-strip-rule atlas-strip-rule--end" aria-hidden="true" />
    </button>
  );
}
