/**
 * ConquestCommandRail — the desktop left command rail.
 *
 * ONE professional command surface that runs the left gutter from just under
 * the header down to the command deck's top line.  It frames the dead space on
 * the left and gently connects toward the map, holding three flush sections
 * separated by thin dividers (NOT three detached black boxes):
 *
 *   1. Oyuncular / skor / sıra        → `players`  (rows, neutral, kâhin,
 *                                        gizli envanter — provided by the game)
 *   2. Kader Kartı hakkı + aksiyonu   → `fate`     (ConquestFateCardWidget)
 *   3. Bu Maçtaki Bonuslar (dinamik)  → `bonuses`  (ConquestBonusGuide rail)
 *
 * Presentation only — it pulls already-wired content/actions in as slots and
 * adds no new buttons, phases, or game logic.  Desktop-only by construction:
 * the mobile shell (MobileConquestLayout) never renders it.
 *
 * Layout contract (see `.cq-command-rail` in App.css):
 *   • The outer frame spans the full battlefield height as a low-contrast
 *     ambient surface; the content shell sits at the top and only takes the
 *     height its content needs, so a sparse rail never reads as one huge empty
 *     panel — the remainder stays passive ambience.
 *   • The frame is `pointer-events: none`; interactive children (kâhin, gizli
 *     envanter, Kader Kartı, bonus rows) re-enable pointer-events individually.
 *   • A long bonus set scrolls inside ITS OWN section box, so the rail keeps
 *     its height and the map keeps its rect.
 */

import type { ReactNode } from "react";
import { EmojiIcon } from "../../components/EmojiIcon";

interface Props {
  /** Section 1 body: player/team rows, neutral row, kâhin preview, gizli
   *  envanter — passed straight through from the game. */
  players:   ReactNode;
  /** Section 2 body: the Kader Kartı widget.  Omit (undefined) outside a live
   *  match or for spectators so the section — header included — is not shown. */
  fate?:     ReactNode;
  /** Section 3 body: the dynamic bonus guide (rail variant).  Omitted when the
   *  match has no bonus assignment. */
  bonuses?:  ReactNode;
  /** Team mode hides the "Oyuncular" header (each team group carries its own
   *  label) and lets the panel tighten its grouping. */
  teamMode?: boolean;
}

export default function ConquestCommandRail({
  players,
  fate,
  bonuses,
  teamMode = false,
}: Props) {
  return (
    <aside className="cq-command-rail" aria-label="Komuta rayı">
      <div
        className="cq-command-rail-shell"
        data-team-mode={teamMode ? "true" : undefined}
      >
        {/* İçerik katmanı: üç bölüm üstte DOĞAL yüksekliğinde.  Altındaki
            .cq-command-rail-fill kalan alanı pasif rail yüzeyi olarak command
            deck üst çizgisine kadar sürdürür (dev boş kart değil). */}
        <div className="cq-command-rail-content">
        {/* ── 1 · Oyuncular / skor / sıra ─────────────────────────── */}
        <section className="cq-rail-section cq-rail-section--players">
          {!teamMode && (
            <h4 className="cq-rail-section-head">
              <EmojiIcon name="bust" />
              <span>Oyuncular</span>
            </h4>
          )}
          {/* role=list + name preserved exactly as the old panel exposed it. */}
          <div className="cq-rail-players" role="list" aria-label="Oyuncular">
            {players}
          </div>
        </section>

        {/* ── 2 · Kader Kartı ─────────────────────────────────────── */}
        {fate && (
          <section className="cq-rail-section cq-rail-section--fate">
            <h4 className="cq-rail-section-head cq-rail-section-head--fate">
              <EmojiIcon name="joker" />
              <span>Kader Kartı</span>
            </h4>
            {fate}
          </section>
        )}

        {/* ── 3 · Bu Maçtaki Bonuslar (varsa) ─────────────────────── */}
        {bonuses && (
          <section className="cq-rail-section cq-rail-section--bonus">
            {bonuses}
          </section>
        )}
        </div>
        {/* Pasif rail continuation — içerik bittikten sonra çerçevenin koyu,
            düşük kontrastlı yüzeyi command deck'e kadar sürer; içerik çerçeveyi
            doldurursa 0'a iner. */}
        <div className="cq-command-rail-fill" aria-hidden="true" />
      </div>
    </aside>
  );
}
