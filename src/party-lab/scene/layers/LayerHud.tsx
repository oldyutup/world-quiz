import type { MutableRefObject } from "react";
import { PLAYERS } from "../players";
import type { LayerHudElements, LayerSnapshot } from "./LayerPlayground";

/**
 * Local Katman Kaosu gameplay HUD on the immersive arena: who is still in, the round
 * clock, countdown / fall / result messages, the spectator label and the anti-stall
 * banner. The debug readout is always written (scripts read `data-layers`) but only
 * shown when the Esc menu's debug panel is open.
 */
export default function LayerHud({ snapshot, hud, debugOpen }: { snapshot: LayerSnapshot; hud: MutableRefObject<LayerHudElements>; debugOpen: boolean }) {
  const players = PLAYERS.filter((player) => snapshot.active[player.id]);
  const out = snapshot.phase === "playing" && !snapshot.alive[0];
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
        {snapshot.phase === "playing" && (
          <span className="pl-round-clock" aria-label={`Geçen süre: ${snapshot.seconds} saniye`}>
            {snapshot.seconds} sn
          </span>
        )}
      </div>
      <div className="pl-layer-banner" aria-live="polite" ref={(element) => void (hud.current.banner = element)} />
      <div className="pl-arena-side">
        <div className="pl-debug-panel" hidden={!debugOpen} aria-hidden="true">
          <pre className="pl-layer-debug" ref={(element) => void (hud.current.debug = element)} />
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
              <span>Hazır ol! Bastığın karo kırılır. Alt katmana düşmek serbest; en alttan düşen elenir.</span>
            </>
          )}
          {out && (
            <>
              <strong>Düştün!</strong>
              <span>Son katmanın altına düştün. Diğerlerini izle.</span>
            </>
          )}
          {snapshot.phase === "results" && (
            <>
              <strong style={{ color: snapshot.winner === null ? undefined : PLAYERS[snapshot.winner].color }}>
                {snapshot.winner === null ? "Berabere!" : `${PLAYERS[snapshot.winner].label} kazandı!`}
              </strong>
              <span>
                {snapshot.reason === "all-fell" ? "Son oyuncular aynı anda düştü. " : snapshot.reason === "timeout" ? "Süre sınırı. " : ""}
                {snapshot.endedAt.toFixed(1)} sn · Yeni tur birazdan.
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
