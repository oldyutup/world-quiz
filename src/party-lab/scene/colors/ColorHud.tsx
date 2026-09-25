import type { MutableRefObject } from "react";
import { PLAYERS } from "../players";
import { COLOR_IDS, type ColorIndex } from "../../../../shared/party-lab/simulation/colors/config";
import type { ColorPhase } from "../../../../shared/party-lab/simulation/colors/schedule";
import type { ColorHudElements, ColorSnapshot } from "./ColorPlayground";
import { colorLabel, colorSymbol, TILE_HEX, TILE_INK } from "./palette";

/** The tile symbol (the colour's second cue) as a small inline SVG, drawn in `ink`. */
export function ColorSymbol({ color, ink }: { color: ColorIndex; ink: string }) {
  const symbol = colorSymbol(color);
  return (
    <svg viewBox="-10 -10 20 20" aria-hidden="true" className="pl-color-symbol">
      {symbol === "circle" && <circle r="5.2" fill="none" stroke={ink} strokeWidth="2.4" />}
      {symbol === "stripes" && (
        <g stroke={ink} strokeWidth="2.2">
          <line x1="-8" y1="2" x2="2" y2="-8" />
          <line x1="-4" y1="7" x2="7" y2="-4" />
        </g>
      )}
      {symbol === "triangle" && <polygon points="0,-6.5 6,4 -6,4" fill="none" stroke={ink} strokeWidth="2.2" strokeLinejoin="round" />}
      {symbol === "cross" && <path d="M-6 0H6M0 -6V6" stroke={ink} strokeWidth="2.6" />}
    </svg>
  );
}

/**
 * The target chip: the colour's swatch and symbol, its name, the instruction and the
 * reaction timer and bar (both written per frame into `hud`); "SON!" in the final drop,
 * "Hazır ol" in the preview. Local and online Renk Kaosu.
 */
export function ColorTargetChip({
  cyclePhase,
  target,
  final,
  hud,
}: {
  cyclePhase: ColorPhase;
  target: ColorIndex;
  final: boolean;
  hud: MutableRefObject<Pick<ColorHudElements, "timer" | "bar">>;
}) {
  const showTarget = cyclePhase !== "preview";
  return (
    <div
      className="pl-color-target"
      data-phase={cyclePhase}
      data-color={showTarget && !final ? COLOR_IDS[target] : undefined}
      data-final={final || undefined}
      role="status"
      aria-live="polite"
      aria-label={final ? "Son düşüş: kalan karolar da düşüyor" : showTarget ? `Hedef renk: ${colorLabel(target)}` : "Renkler değişti, hedef birazdan"}
    >
      {showTarget && final ? (
        <>
          <span className="pl-color-swatch pl-color-swatch-final" aria-hidden="true" />
          <span className="pl-color-name">
            <b>SON!</b>
            <small>{cyclePhase === "run" ? "Hepsi düşüyor · en son düşen kazanır" : "En son düşen kazanır"}</small>
          </span>
          <span className="pl-color-timer" ref={(element) => void (hud.current.timer = element)} />
        </>
      ) : showTarget ? (
        <>
          <span className="pl-color-swatch" style={{ backgroundColor: TILE_HEX[target] }}>
            <ColorSymbol color={target} ink={TILE_INK[target]} />
          </span>
          <span className="pl-color-name">
            <b>{colorLabel(target)}</b>
            <small>{cyclePhase === "run" ? "Bu renge geç!" : "Yerinde kal!"}</small>
          </span>
          <span className="pl-color-timer" ref={(element) => void (hud.current.timer = element)} />
        </>
      ) : (
        <span className="pl-color-name">
          <b>{final ? "Son düşüş" : "Hazır ol"}</b>
          <small>{final ? "Renk kalmadı · karolar birazdan düşüyor" : "Renkler değişti · hedef geliyor"}</small>
        </span>
      )}
      <span className="pl-color-bar" aria-hidden="true">
        <span ref={(element) => void (hud.current.bar = element)} style={{ backgroundColor: final ? "#ffffff" : TILE_HEX[target] }} />
      </span>
    </div>
  );
}

/**
 * Local Renk Kaosu HUD on the immersive arena: who is still in, the target colour with
 * its symbol and the reaction timer, the big "MAVİ!" call on each announcement, the
 * "DARALIYOR!" tag through every cycle that marks tiles to leave (it pops in when the
 * cycle starts), the countdown / fall / result messages and the spectator label. The
 * debug readout is always written (scripts read `data-colors`) but only shown when the
 * Esc menu's debug panel is open.
 */
export default function ColorHud({ snapshot, hud, debugOpen }: { snapshot: ColorSnapshot; hud: MutableRefObject<ColorHudElements>; debugOpen: boolean }) {
  const players = PLAYERS.filter((player) => snapshot.active[player.id]);
  const out = snapshot.phase === "playing" && !snapshot.alive[0];
  const playing = snapshot.phase === "playing";
  const target = snapshot.target;
  const final = snapshot.final;
  return (
    <>
      <div className="pl-round-hud">
        <ul className="pl-roster" aria-label="Oyuncu durumları">
          {players.map((player) => (
            <li key={player.id} className={snapshot.alive[player.id] ? "" : "pl-eliminated"}>
              <span className="pl-player-dot" style={{ backgroundColor: player.color }} aria-hidden="true" />
              <span>
                <b>
                  {player.label} <small>{player.id === 0 ? "Sen" : "Bot"}</small>
                </b>
                <span>{snapshot.alive[player.id] ? "Oyunda" : "Düştü"}</span>
              </span>
            </li>
          ))}
        </ul>
        {playing && (
          <span className="pl-round-clock" aria-label={`Tur ${snapshot.cycle}`}>
            Tur {snapshot.cycle}
          </span>
        )}
      </div>
      {playing && <ColorTargetChip cyclePhase={snapshot.cyclePhase} target={target} final={final} hud={hud} />}
      {playing && !out && snapshot.shrinking && (
        <div key={snapshot.cycle} className="pl-color-shrink" role="status">
          DARALIYOR!
        </div>
      )}
      <div className="pl-color-callout" aria-hidden="true" ref={(element) => void (hud.current.callout = element)} />
      <div className="pl-arena-side">
        <div className="pl-debug-panel" hidden={!debugOpen} aria-hidden="true">
          <pre className="pl-color-debug" ref={(element) => void (hud.current.debug = element)} />
        </div>
      </div>
      {out && snapshot.spectating !== null && (
        <div className="pl-layer-spectate" role="status">
          İzleniyor: <b style={{ color: PLAYERS[snapshot.spectating].color }}>{PLAYERS[snapshot.spectating].label}</b>
          <span> · Q / E değiştir</span>
        </div>
      )}
      {(snapshot.phase !== "playing" || out) && (
        <div className={`pl-arena-message pl-round-message${snapshot.phase === "results" ? " pl-result-pulse" : ""}`} role="status" aria-atomic="true">
          {snapshot.phase === "countdown" && (
            <>
              <strong>{snapshot.seconds}</strong>
              <span>Hazır ol! Hedef rengi bul ve üstünde kal. Diğer renkler düşer; aşağı düşen elenir.</span>
            </>
          )}
          {out && (
            <>
              <strong>Düştün!</strong>
              <span>Karonun altı boşaldı. Diğerlerini izle.</span>
            </>
          )}
          {snapshot.phase === "results" && (
            <>
              <strong style={{ color: snapshot.winner === null ? undefined : PLAYERS[snapshot.winner].color }}>
                {snapshot.winner === null ? "Berabere!" : `${PLAYERS[snapshot.winner].label} kazandı!`}
              </strong>
              <span>
                {snapshot.reason === "all-fell" ? "Son oyuncular aynı anda düştü. " : snapshot.reason === "timeout" ? "Süre sınırı. " : ""}
                {snapshot.cycle} tur · {snapshot.endedAt.toFixed(1)} sn · Yeni tur birazdan.
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
