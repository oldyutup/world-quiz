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
 *   • The frame spans the full battlefield height (header → command deck) as ONE
 *     ambient surface.  The shell is a single vertical flex flow: Oyuncular and
 *     Kader Kartı take their natural height, and Bu Maçtaki Bonuslar takes the
 *     remaining space (minmax(0,1fr)) — so a sparse rail fades to passive ambience
 *     rather than a separate empty card, and a tall one fills cleanly.
 *   • ONLY the bonus list scrolls (inside its own box).  The frame and shell are
 *     `overflow: hidden`, so the rail never produces a second/global scrollbar and
 *     the map keeps its rect.
 *   • The frame is `pointer-events: none`; interactive children (kâhin, gizli
 *     envanter, Kader Kartı, bonus rows) re-enable pointer-events individually.
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
        {/* Tek dikey akış: Oyuncular (auto) / Kader Kartı (auto) / Bonuslar
            (kalan alanı alır, içindeki liste kendi kutusunda kayar).  Eski
            .cq-command-rail-content + .cq-command-rail-fill katmanları kaldırıldı
            → ray hiçbir katmanda ikinci scrollbar üretmez. */}
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
    </aside>
  );
}
