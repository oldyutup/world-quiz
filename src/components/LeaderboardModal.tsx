/**
 * LeaderboardModal.tsx
 *
 * Ana ekrandan acilan Sıralama modalı — "Atlas Klasmanı" (V2).
 *
 *  - XP / Gold toggle (varsayilan XP). XP = mavi keşif/ilerleme dili;
 *    Gold = yalnız değer + sikke + ilk üç detaylarında sıcak kehribar.
 *  - XP icin mod sekmeleri: Genel / Ülke Yaz / Bayrak / Çark / Kuşatma.
 *    "Çark" sekmesi server-side wheel_duel + wheel_group XP toplamini gosterir.
 *  - Gold sekmesinde mod sekmesi yok; genel Gold sıralamasi.
 *  - İlk 3 oyuncu parşömen podyumda (1 ortada/yüksek). 4+ tek bütünleşik
 *    atlas kaydı (kolon başlıklı liste) olarak akar.
 *  - Bakan oyuncu ilk 10 icindeyse client-side "SEN" etiketi + kontrollü mavi
 *    odakla ayrışır (sıralamayı/veriyi/filtreyi DEĞİŞTİRMEZ).
 *  - Loading (skeleton) / empty / error (tekrar dene) state.
 *  - ESC veya overlay'a tiklayinca kapanir.
 *
 * Veri (DEĞİŞMEDİ):
 *  - public.get_xp_leaderboard(p_scope, p_limit) RPC
 *  - public.get_gold_leaderboard(p_limit) RPC
 *  - Email / hassas alan client'a dusmez (RPC public alan dondurur).
 *  - profiles.id === auth.uid() (bkz. getProfile) → "SEN" tespiti supabase.auth
 *    ile yapilir, ek RPC/rank verisi gerektirmez.
 */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";
import GoldIcon from "./GoldIcon";

/** Mobil / dar görünüm (≤520px) tespiti. Leaderboard'u mobilde toplam 8 kişiyle
 *  (podyum 3 + liste 5 → rank 4–8) sınırlamak için YALNIZ render katmanında
 *  kullanılır. Veri/RPC (p_limit:10) değişmez; desktop (>520px) tam listeyi
 *  (rank 4–10) görmeye devam eder. Resize/rotate'a tepki verir. */
function useIsNarrow(): boolean {
  const QUERY = "(max-width: 520px)";
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return narrow;
}

type LeaderType = "xp" | "gold";
type XpScope = "general" | "country" | "flag" | "wheel" | "conquest";

interface XpRow {
  profile_id: string;
  username:   string | null;
  avatar_id:  string | null;
  xp:         number;
  total_xp:   number;
  level:      number;
}
interface GoldRow {
  profile_id: string;
  username:   string | null;
  avatar_id:  string | null;
  gold:       number;
  total_xp:   number;
  level:      number;
}
type Row = XpRow | GoldRow;

const XP_SCOPES: ReadonlyArray<{ key: XpScope; label: string }> = [
  { key: "general",  label: "Genel" },
  { key: "country",  label: "Ülke Yaz" },
  { key: "flag",     label: "Bayrak" },
  { key: "wheel",    label: "Çark" },
  { key: "conquest", label: "Kuşatma" },
];

/* ── Atlas ikon ailesi: tek stroke/weight, dairesel. Katalogdaki renkli Fluent
   emoji yerine bu rafine çizgi seti kullanılır (premium atlas dili). ── */
function CompassMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 5.4 L13.65 10.35 L18.6 12 L13.65 13.65 L12 18.6 L10.35 13.65 L5.4 12 L10.35 10.35 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <circle cx="12" cy="12" r="1.05" fill="currentColor" />
    </svg>
  );
}

/* ── Gold kısaltma: büyük değerleri K/M/B ile kısa, hizalı göster.
   En fazla 1 ondalık, gereksiz ".0" düşer, ondalık ayıracı tr-TR (virgül):
     1.250 → 1,2K · 12.400 → 12,4K · 145.000 → 145K · 2.300.000 → 2,3M
     98.700.000 → 98,7M · ≥1 milyar → B. <1000 tam sayı (gruplu).
   YALNIZ gold gösteriminde kullanılır; XP tam değerini korur. ── */
function formatGold(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const tiers: ReadonlyArray<{ v: number; s: string }> = [
    { v: 1_000_000_000, s: "B" },
    { v: 1_000_000, s: "M" },
    { v: 1_000, s: "K" },
  ];
  for (const t of tiers) {
    if (abs >= t.v) {
      // 1 ondalığa AŞAĞI yuvarla (1.250 → 1,2K, gösterimi şişirme yok);
      // 1e-9 epsilon yalnız kayan-nokta hatasını telafi eder (2,3 → 22,99… → 23).
      const scaled = Math.floor((abs / t.v) * 10 + 1e-9) / 10;
      return sign + scaled.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + t.s;
    }
  }
  return sign + abs.toLocaleString("tr-TR");
}

interface Props {
  onClose: () => void;
}

export function LeaderboardModal({ onClose }: Props) {
  const [type, setType]   = useState<LeaderType>("xp");
  const [scope, setScope] = useState<XpScope>("general");

  const [xpRows,   setXpRows]   = useState<XpRow[]>([]);
  const [goldRows, setGoldRows] = useState<GoldRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** Bakan oyuncunun profil id'si (profiles.id === auth.uid()). Yalnız "SEN"
   *  vurgusu icin; sıralama/veri/filtre mantığını ETKİLEMEZ. */
  const [selfId, setSelfId] = useState<string | null>(null);

  /** Mobil/dar görünümde toplam gösterilen sıralama 8'e iner (render-only). */
  const isNarrow = useIsNarrow();
  /** Aktif mod sekmesi — dar ekranda yatay rail'de görünür konuma kaydırılır. */
  const activeScopeRef = useRef<HTMLButtonElement | null>(null);

  // ESC kapatma
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Bakan oyuncu kim?
  useEffect(() => {
    let alive = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (alive) setSelfId(data.user?.id ?? null);
    });
    return () => { alive = false; };
  }, []);

  // Veri cekme — type/scope/reload degisince
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    const run = async () => {
      try {
        if (type === "xp") {
          const { data, error: rpcErr } = await supabase.rpc("get_xp_leaderboard", {
            p_scope: scope,
            p_limit: 10,
          });
          if (!alive) return;
          if (rpcErr) {
            setError("Sıralama yüklenemedi.");
            setXpRows([]);
            return;
          }
          setXpRows(Array.isArray(data) ? (data as XpRow[]) : []);
        } else {
          const { data, error: rpcErr } = await supabase.rpc("get_gold_leaderboard", {
            p_limit: 10,
          });
          if (!alive) return;
          if (rpcErr) {
            setError("Sıralama yüklenemedi.");
            setGoldRows([]);
            return;
          }
          setGoldRows(Array.isArray(data) ? (data as GoldRow[]) : []);
        }
      } catch {
        if (!alive) return;
        setError("Sıralama yüklenemedi.");
      } finally {
        if (alive) setLoading(false);
      }
    };

    void run();
    return () => { alive = false; };
  }, [type, scope, reloadKey]);

  // Mod sekmesi değişince (yalnız XP'de sekmeler var) aktif sekmeyi yatay rail'de
  // görünür konuma getir → "Kuşatma" gibi sondaki sekme seçiliyken kenarda yarım
  // kalmaz. Yatay eksende ("inline:nearest"), sayfayı/modali dikeyde zıplatmadan.
  useEffect(() => {
    if (type !== "xp") return;
    const el = activeScopeRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "nearest", block: "nearest" });
  }, [scope, type]);

  const rows: Row[] = type === "xp" ? xpRows : goldRows;
  const isEmpty = !loading && !error && rows.length === 0;
  const unit = type === "xp" ? "XP" : "Gold";

  const valueOf = (row: Row) => (type === "xp" ? (row as XpRow).xp : (row as GoldRow).gold);
  const isSelf  = (row: Row) => !!selfId && row.profile_id === selfId;

  // İlk 3 → podyum (görsel sıra: 2 sol · 1 orta/yüksek · 3 sağ). 4+ → liste.
  const top = rows.slice(0, 3);
  // Mobil/dar (≤520px): liste rank 4–8 (5 satır) → toplam 8 kişi. Desktop: rank
  // 4–10 (7 satır) → toplam 10. Yalnız render katmanı; çekilen veri (p_limit:10)
  // her iki tarafta da aynıdır, sıralama/filtre değişmez.
  const listRows = isNarrow ? rows.slice(3, 8) : rows.slice(3);
  const podiumOrder: { row: Row; rank: number }[] =
    top.length >= 3
      ? [
          { row: top[1], rank: 2 },
          { row: top[0], rank: 1 },
          { row: top[2], rank: 3 },
        ]
      : top.map((row, i) => ({ row, rank: i + 1 }));

  return (
    <div className="lb-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="lb-title">
      <div className="lb-modal" data-type={type} onClick={(e) => e.stopPropagation()}>
        <span className="lb-corner lb-corner--tl" aria-hidden="true" />
        <span className="lb-corner lb-corner--tr" aria-hidden="true" />
        <span className="lb-corner lb-corner--bl" aria-hidden="true" />
        <span className="lb-corner lb-corner--br" aria-hidden="true" />

        <header className="lb-head">
          <div className="lb-brand">
            <span className="lb-brand-mark" aria-hidden="true"><CompassMark /></span>
            <span className="lb-brand-text">
              <span className="lb-overline">KEŞİF SIRALAMASI</span>
              <h2 className="lb-title" id="lb-title">ATLAS KLASMANI</h2>
            </span>
          </div>

          {/* XP / Gold toggle */}
          <div className="lb-type-toggle" role="tablist" aria-label="Sıralama türü">
            <button
              type="button"
              role="tab"
              aria-selected={type === "xp"}
              className="lb-type-btn"
              onClick={() => setType("xp")}
            >
              XP
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={type === "gold"}
              className="lb-type-btn lb-type-btn--gold"
              onClick={() => setType("gold")}
            >
              <GoldIcon className="lb-type-coin" />
              Gold
            </button>
          </div>

          <button type="button" className="lb-close" onClick={onClose} aria-label="Kapat">
            ×
          </button>
        </header>

        {/* Mod sekmeleri sadece XP icin */}
        {type === "xp" && (
          <div className="lb-scope-tabs" role="tablist" aria-label="Mod">
            {XP_SCOPES.map((s) => (
              <button
                key={s.key}
                ref={scope === s.key ? activeScopeRef : undefined}
                type="button"
                role="tab"
                aria-selected={scope === s.key}
                className={`lb-scope-btn${scope === s.key ? " lb-scope-btn--active" : ""}`}
                onClick={() => setScope(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="lb-body">
          {loading && (
            <>
              <span className="lb-sr-only" role="status">Sıralama yükleniyor…</span>
              <section className="lb-podium lb-podium--sk" aria-hidden="true">
                {[2, 1, 3].map((r) => (
                  <div key={r} className={`lb-pod lb-pod--r${r}`}>
                    <span className="lb-sk lb-sk-avatar" />
                    <span className="lb-sk lb-sk-line" />
                    <span className="lb-sk lb-sk-pill" />
                  </div>
                ))}
              </section>
              <section className="lb-board" aria-hidden="true">
                <ul className="lb-list">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <li key={i} className="lb-row lb-row--sk">
                      <span className="lb-sk lb-sk-rank" />
                      <span className="lb-sk lb-sk-avatar-sm" />
                      <span className="lb-sk lb-sk-line" />
                      <span className="lb-sk lb-sk-val" />
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {error && !loading && (
            <div className="lb-state lb-state--error" role="alert">
              <p>{error}</p>
              <button type="button" className="lb-retry" onClick={() => setReloadKey((k) => k + 1)}>
                Tekrar dene
              </button>
            </div>
          )}

          {isEmpty && (
            <div className="lb-state lb-state--empty">
              <span className="lb-empty-mark" aria-hidden="true"><CompassMark /></span>
              <p>Henüz sıralama verisi yok.</p>
              <span className="lb-empty-sub">Keşfet, kazan, adını bu atlasa yazdır.</span>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <>
              <section className="lb-podium" aria-label="İlk üç">
                {podiumOrder.map(({ row, rank }) => {
                  const name = row.username ?? "—";
                  const mine = isSelf(row);
                  return (
                    <div
                      key={row.profile_id}
                      className={`lb-pod lb-pod--r${rank}${mine ? " lb-pod--self" : ""}`}
                    >
                      <PlayerProfileTrigger
                        profileId={row.profile_id}
                        className={`lb-pod-medallion lb-pod-medallion--r${rank}`}
                      >
                        <span className="lb-sr-only">{rank}. sıra: </span>
                        <PlayerAvatar
                          avatarId={row.avatar_id}
                          username={name}
                          size={rank === 1 ? 80 : 60}
                          className="lb-pod-avatar"
                        />
                        <span className={`lb-pod-badge lb-pod-badge--r${rank}`} aria-hidden="true">
                          {rank}
                        </span>
                      </PlayerProfileTrigger>
                      <span className="lb-pod-name">
                        @{name}
                        {mine && <span className="lb-self-chip">SEN</span>}
                      </span>
                      <span className="lb-pod-meta">
                        {/* Gold ilk 3'te seviye gösterilmez; ana veri gold değeridir. */}
                        {type !== "gold" && (
                          <span className="lb-pod-level">SEVİYE {row.level}</span>
                        )}
                        <span className="lb-pod-xp">
                          {type === "gold" && <GoldIcon className="lb-val-coin" />}
                          <span className="lb-pod-num">
                            {type === "gold"
                              ? formatGold(valueOf(row))
                              : valueOf(row).toLocaleString("tr-TR")}
                          </span>
                          <span className="lb-pod-unit">{unit}</span>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </section>

              {listRows.length > 0 && (
                <section className="lb-board">
                  <div className="lb-board-head" aria-hidden="true">
                    <span className="lb-col-rank">SIRA</span>
                    <span className="lb-col-name">OYUNCU</span>
                    <span className="lb-col-level">SEVİYE</span>
                    <span className="lb-col-value">{type === "xp" ? "XP" : "GOLD"}</span>
                  </div>
                  <ul className="lb-list">
                    {listRows.map((row, idx) => {
                      const rank = idx + 4;
                      const name = row.username ?? "—";
                      const mine = isSelf(row);
                      return (
                        <li
                          key={row.profile_id}
                          className={`lb-row${mine ? " lb-row--self" : ""}`}
                        >
                          <span className="lb-rank">{rank}</span>
                          <PlayerProfileTrigger profileId={row.profile_id} className="lb-player">
                            <PlayerAvatar
                              avatarId={row.avatar_id}
                              username={name}
                              size="sm"
                              className="lb-avatar"
                            />
                            <span className="lb-name">
                              @{name}
                              {mine && <span className="lb-self-chip">SEN</span>}
                            </span>
                          </PlayerProfileTrigger>
                          <span className="lb-level">
                            <span className="lb-level-hex">{row.level}</span>
                          </span>
                          <span className="lb-value">
                            {type === "gold" && <GoldIcon className="lb-val-coin" />}
                            <span className="lb-value-num">
                              {type === "gold"
                                ? formatGold(valueOf(row))
                                : valueOf(row).toLocaleString("tr-TR")}
                            </span>
                            <span className="lb-value-suffix">{unit}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
