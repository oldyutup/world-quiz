/**
 * LeaderboardModal.tsx
 *
 * Ana ekrandan acilan Sıralama modalı (V1).
 *
 *  - XP / Gold toggle (varsayilan XP).
 *  - XP icin mod sekmeleri: Genel / Ülke Yaz / Bayrak / Çark / Kuşatma.
 *    "Çark" sekmesi server-side wheel_duel + wheel_group XP toplamini gosterir.
 *  - Gold sekmesinde mod sekmesi yok; genel Gold sıralamasi.
 *  - Her listede ilk 10 oyuncu: rank, isim, level, XP/Gold.
 *  - Loading / empty / error state.
 *  - ESC veya overlay'a tiklayinca kapanir.
 *
 * Veri:
 *  - public.get_xp_leaderboard(p_scope, p_limit) RPC
 *  - public.get_gold_leaderboard(p_limit) RPC
 *  - Email / hassas alan client'a dusmez (RPC public alan dondurur).
 */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";

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

const XP_SCOPES: ReadonlyArray<{ key: XpScope; label: string }> = [
  { key: "general",  label: "Genel" },
  { key: "country",  label: "Ülke Yaz" },
  { key: "flag",     label: "Bayrak" },
  { key: "wheel",    label: "Çark" },
  { key: "conquest", label: "Kuşatma" },
];

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

  // ESC kapatma
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Veri cekme — type/scope degisince
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
  }, [type, scope]);

  const rows = type === "xp" ? xpRows : goldRows;
  const isEmpty = !loading && !error && rows.length === 0;

  return (
    <div className="lb-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="lb-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="lb-close"
          onClick={onClose}
          aria-label="Kapat"
        >
          ×
        </button>

        <div className="lb-head">
          <h2 className="lb-title">🏆 Sıralama</h2>
        </div>

        {/* XP / Gold toggle */}
        <div className="lb-type-toggle" role="tablist" aria-label="Sıralama türü">
          <button
            type="button"
            role="tab"
            aria-selected={type === "xp"}
            className={`lb-type-btn${type === "xp" ? " lb-type-btn--active" : ""}`}
            onClick={() => setType("xp")}
          >
            XP
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={type === "gold"}
            className={`lb-type-btn${type === "gold" ? " lb-type-btn--active" : ""}`}
            onClick={() => setType("gold")}
          >
            🟡 Gold
          </button>
        </div>

        {/* Mod sekmeleri sadece XP icin */}
        {type === "xp" && (
          <div className="lb-scope-tabs" role="tablist" aria-label="Mod">
            {XP_SCOPES.map((s) => (
              <button
                key={s.key}
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

        <div className="lb-list-wrap">
          {loading && (
            <div className="lb-state lb-state--loading">Sıralama yükleniyor…</div>
          )}
          {error && !loading && (
            <div className="lb-state lb-state--error">{error}</div>
          )}
          {isEmpty && (
            <div className="lb-state lb-state--empty">Henüz sıralama verisi yok.</div>
          )}

          {!loading && !error && rows.length > 0 && (
            <ul className="lb-list">
              {rows.map((row, idx) => {
                const rank = idx + 1;
                const name = row.username ?? "—";
                const value = type === "xp"
                  ? (row as XpRow).xp
                  : (row as GoldRow).gold;
                const valueSuffix = type === "xp" ? "XP" : "Gold";
                return (
                  <li
                    key={row.profile_id}
                    className={`lb-row${rank <= 3 ? ` lb-row--top${rank}` : ""}`}
                  >
                    <span className="lb-rank">{rank}</span>
                    <PlayerProfileTrigger profileId={row.profile_id} className="lb-player">
                      <PlayerAvatar
                        avatarId={row.avatar_id}
                        username={name}
                        size="sm"
                        highlight={rank <= 3}
                        className="lb-avatar"
                      />
                      <span className="lb-name">@{name}</span>
                    </PlayerProfileTrigger>
                    <span className="lb-level">Lv.&nbsp;{row.level}</span>
                    <span className="lb-value">
                      {type === "gold" && <span className="lb-coin">🟡</span>}
                      <span className="lb-value-num">{value.toLocaleString("tr-TR")}</span>
                      <span className="lb-value-suffix">{valueSuffix}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
