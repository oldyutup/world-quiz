/**
 * MobileJokerRail — the local player's own bonuses, surfaced as a real
 * strategic readout instead of 12px corner chips.
 *
 * The problem this solves: on a phone the only trace of "I am holding Kâhin
 * Büyüsü / Liman / Zaman Takviyesi" was a pair of tiny icons stacked on the
 * corner of a score pill, competing with the score number for the same few
 * pixels.  Players could hold a match-deciding bonus for three rounds
 * without noticing it.
 *
 * Two kinds of entry, deliberately styled the same because to the player
 * they are the same thing — an advantage they currently have:
 *   • charge   — a one-shot the player has banked (Gizli Operasyon hazır,
 *                Eleme Yetkisi hazır, +5sn on the next move)
 *   • holding  — a bonus region they currently own (Kâhin, Liman, Bereket…)
 *
 * The rail is presentation only: it never triggers a bonus, because no
 * Kuşatma bonus is player-triggered — they fire from owning a region or
 * from the next qualifying action.  Tapping an entry opens its description,
 * nothing more.  Keeping it inert is what lets this ship without touching
 * a single gameplay rule.
 */

import { useState } from "react";
import { ConquestBonusIcon } from "../ConquestAssetIcon";
import { getBonusTypePresentation } from "../regionBonuses";
import type { ConquestRegionBonusType } from "../types";

export interface JokerEntry {
  /** Stable key — bonus type plus a discriminator for repeated types. */
  key:   string;
  type?: ConquestRegionBonusType;
  /** Emoji fallback for bonuses with no PNG asset. */
  icon:  string;
  label: string;
  /** Short state suffix rendered as a badge: "hazır", "+5sn", "3/10"… */
  state?: string;
  /** Long-form copy shown when the entry is tapped. */
  detail: string;
  /** Drives the rim tint so a defensive holding never reads as an attack. */
  category?: "savunma" | "saldiri" | "bilgi" | "ekonomi";
}

interface Props {
  entries: JokerEntry[];
  /** "rail" = vertical strip floated on the board (landscape).
   *  "row"  = horizontal strip under the score row (portrait). */
  variant?: "rail" | "row";
}

export default function MobileJokerRail({ entries, variant = "rail" }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (entries.length === 0) return null;

  const open = entries.find(e => e.key === openKey) ?? null;

  return (
    <div className={`mcq-joker-rail mcq-joker-rail--${variant}`}>
      <ul className="mcq-joker-list" aria-label="Elindeki bonuslar">
        {entries.map(e => {
          const pres = e.type ? getBonusTypePresentation(e.type) : null;
          return (
            <li key={e.key}>
              <button
                type="button"
                className="mcq-joker-btn"
                data-open={e.key === openKey ? "true" : undefined}
                data-cat={e.category}
                onClick={() => setOpenKey(k => (k === e.key ? null : e.key))}
                aria-expanded={e.key === openKey}
                aria-label={`${e.label}${e.state ? ` — ${e.state}` : ""}`}
                title={`${e.label}${e.state ? ` — ${e.state}` : ""}`}
              >
                <span className="mcq-joker-icon" aria-hidden="true">
                  {e.type
                    ? <ConquestBonusIcon
                        type={e.type}
                        fallbackChar={pres?.icon ?? e.icon}
                        alt={e.label}
                        size={22}
                      />
                    : e.icon}
                </span>
                {e.state && (
                  <span className="mcq-joker-state" aria-hidden="true">{e.state}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {open && (
        <div className="mcq-joker-detail" role="dialog" aria-label={open.label}>
          <div className="mcq-joker-detail-head">
            <span className="mcq-joker-detail-title">{open.label}</span>
            {open.state && (
              <span className="mcq-joker-detail-state">{open.state}</span>
            )}
            <button
              type="button"
              className="mcq-joker-detail-close"
              onClick={() => setOpenKey(null)}
              aria-label="Kapat"
            >
              ✕
            </button>
          </div>
          <p className="mcq-joker-detail-desc">{open.detail}</p>
        </div>
      )}
    </div>
  );
}
