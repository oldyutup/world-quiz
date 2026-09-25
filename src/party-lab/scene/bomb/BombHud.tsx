import type { MutableRefObject } from "react";
import { PLAYERS, type PlayerId } from "../players";
import type { BombHudElements, BombSnapshot } from "./BombPlayground";

/** A small cartoon bomb (the HUD's one icon). */
export function BombIcon({ lit = true }: { lit?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pl-bomb-icon" data-lit={lit}>
      <circle cx="10.5" cy="14" r="7.2" fill="currentColor" />
      <rect x="12.2" y="4.6" width="4.4" height="3.6" rx="1" transform="rotate(38 14.4 6.4)" fill="currentColor" />
      <path d="M16.8 5.2c1.2-1.6 2.6-2 4-1.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {lit && <circle cx="21" cy="3.6" r="2" className="pl-bomb-icon-spark" />}
      <circle cx="7.6" cy="11.4" r="1.6" fill="#ffffff" opacity="0.55" />
    </svg>
  );
}

const label = (id: PlayerId) => PLAYERS[id].label;

/**
 * Local Bomba Sende HUD on the immersive arena, only what the round needs: the player cards
 * (who has the bomb, who is protected, who is out), the bomb chip (carrier + fuse timer and
 * bar, written per frame into `hud`), the big call on passes and blasts, the off-screen
 * pointer toward the carrier (or, holding it, the nearest rival), the red edge while you hold
 * it, and the countdown / out / result messages. The debug readout is always written (scripts
 * read `data-bomb`) but shown only when the debug panel is open (`?bombDebug=1`).
 */
export default function BombHud({ snapshot, hud, debugOpen }: { snapshot: BombSnapshot; hud: MutableRefObject<BombHudElements>; debugOpen: boolean }) {
  const players = PLAYERS.filter((player) => snapshot.active[player.id]);
  const playing = snapshot.phase === "playing";
  const out = playing && !snapshot.alive[0];
  const carrier = snapshot.carrier;
  const lit = snapshot.bombPhase === "armed";
  const mine = carrier === 0;
  const status = (id: PlayerId) =>
    !snapshot.alive[id]
      ? snapshot.outBy[id] === "blast"
        ? "Patladı"
        : "Düştü"
      : carrier === id
      ? lit
        ? "BOMBA"
        : "Sıradaki"
      : snapshot.immune === id
      ? "Korumalı"
      : "Oyunda";
  return (
    <>
      <div className="pl-bomb-vignette" aria-hidden="true" ref={(element) => void (hud.current.vignette = element)} />
      <div className="pl-round-hud">
        <ul className="pl-roster" aria-label="Oyuncu durumları">
          {players.map((player) => (
            <li
              key={player.id}
              className={snapshot.alive[player.id] ? "" : "pl-eliminated"}
              data-bomb={carrier === player.id && snapshot.alive[player.id] ? (lit ? "lit" : "next") : undefined}
            >
              <span className="pl-player-dot" style={{ backgroundColor: player.color }} aria-hidden="true" />
              <span>
                <b>
                  {player.label} <small>{player.id === 0 ? "Sen" : "Bot"}</small>
                </b>
                <span className="pl-bomb-status">
                  {carrier === player.id && snapshot.alive[player.id] && <BombIcon lit={lit} />}
                  {status(player.id)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {playing && carrier !== null && (
        <div className="pl-bomb-chip" data-phase={snapshot.bombPhase} data-mine={mine || undefined} role="status" aria-live="polite">
          <span className="pl-bomb-chip-icon">
            <BombIcon lit={lit} />
          </span>
          <span className="pl-bomb-chip-name">
            <b style={{ color: mine ? undefined : PLAYERS[carrier].color }}>{mine ? (lit ? "Bomba sende!" : "Sıradaki sensin") : lit ? label(carrier) : `Sıradaki: ${label(carrier)}`}</b>
            <small>{lit ? (mine ? "Yumrukla başkasına ver" : "Kaç, yakalanma!") : snapshot.lastBlast !== null ? `${label(snapshot.lastBlast)} patladı · yeni fitil` : "Fitil birazdan yanıyor"}</small>
          </span>
          <span className="pl-bomb-fuse" ref={(element) => void (hud.current.fuse = element)} />
          <span className="pl-bomb-bar" aria-hidden="true">
            <span ref={(element) => void (hud.current.bar = element)} />
          </span>
        </div>
      )}
      <div className="pl-bomb-callout" aria-hidden="true" ref={(element) => void (hud.current.callout = element)} />
      <div className="pl-bomb-arrow" aria-hidden="true" data-shown="false" ref={(element) => void (hud.current.arrow = element)}>
        <span className="pl-bomb-arrow-head" />
        <BombIcon />
      </div>
      <div className="pl-arena-side">
        <div className="pl-debug-panel" hidden={!debugOpen} aria-hidden="true">
          <pre className="pl-bomb-debug" ref={(element) => void (hud.current.debug = element)} />
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
              <span>
                {carrier === null
                  ? "Hazır ol!"
                  : mine
                  ? "Bomba sende! Birine yumruk at, bombayı ona ver. Süre bitince elinde patlar."
                  : `Bomba ${label(carrier)} oyuncusunda. Kaç, yakalanma! Süre bitince elinde patlar.`}
              </span>
            </>
          )}
          {out && (
            <>
              <strong>{snapshot.outBy[0] === "blast" ? "Patladın!" : "Düştün!"}</strong>
              <span>Diğerlerini izle.</span>
            </>
          )}
          {snapshot.phase === "results" && (
            <>
              <strong style={{ color: snapshot.winner === null ? undefined : PLAYERS[snapshot.winner].color }}>
                {snapshot.winner === null ? "Berabere!" : snapshot.winner === 0 ? "Kazandın!" : `${PLAYERS[snapshot.winner].label} kazandı!`}
              </strong>
              <span>
                {snapshot.reason === "all-fell" ? "Son oyuncular aynı anda gitti. " : snapshot.reason === "timeout" ? "Süre sınırı. " : ""}
                {snapshot.passes} pas · {snapshot.endedAt.toFixed(1)} sn · Yeni tur birazdan.
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
