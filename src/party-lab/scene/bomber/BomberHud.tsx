import { BOMBER as B, ticks } from "../../../../shared/party-lab/simulation/bomber/config";
import { FELL, ringStates } from "../../../../shared/party-lab/simulation/bomber/game";
import { wireEvents, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";
import "./bomber.css";

export interface BomberHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}
/** Lanes in places order (ties in lane order). */
export const resultOrder = (wire: BomberWire) => wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
/** Seconds of play left at `step`. */
export const secondsLeft = (wire: BomberWire, step: number) => Math.max(0, wire.limit - step / B.hz);

/** The last few hits and falls, newest last. */
function feed(wire: BomberWire, lanes: readonly BomberHudLane[]) {
  return wireEvents(wire)
    .filter((e) => e.kind === "kill")
    .slice(-3)
    .map((e) => {
      if (e.kind !== "kill") return null;
      const victim = lanes[e.victim],
        by = e.by >= 0 ? lanes[e.by] : null;
      return { id: e.id, victim, by: e.by === e.victim ? null : by, self: e.by === e.victim, fell: e.by === FELL };
    })
    .filter((e) => !!e);
}

export default function BomberHud({ wire, step, lanes, self, winner, keys, afterRound, restart }: {
  wire: BomberWire;
  /** Play step shown (fractional). */
  step: number;
  lanes: readonly BomberHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  /** "Space": what puts a bomb down. */
  keys: string;
  afterRound: string;
  /** Yerel Test Arenası: a new arena at once. */
  restart?: () => void;
}) {
  const left = secondsLeft(wire, wire.phase === "playing" ? step : wire.step),
    states = ringStates(Math.floor(step)),
    warning = wire.phase === "playing" && states.some((s) => s === 1),
    falling = wire.phase === "playing" && step >= ticks(B.collapse.start);
  return (
    <div className="pl-bomber-hud">
      {wire.phase !== "results" && (
        <div className={`pl-bomber-clock${falling ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(left)}
        </div>
      )}
      {warning && (
        <p className="pl-bomber-warn" role="status">
          Halka çöküyor!
        </p>
      )}
      <ol className="pl-bomber-feed" aria-label="Vuruşlar">
        {wire.phase === "playing" &&
          feed(wire, lanes).map((e) => (
            <li key={e.id}>
              {e.fell ? (
                <>
                  <b style={{ color: e.victim?.color }}>{e.victim?.name ?? "?"}</b> düştü
                </>
              ) : e.self ? (
                <>
                  <b style={{ color: e.victim?.color }}>{e.victim?.name ?? "?"}</b> kendi bombasıyla <em>−1</em>
                </>
              ) : (
                <>
                  <b style={{ color: e.by?.color }}>{e.by?.name ?? "?"}</b> → <b style={{ color: e.victim?.color }}>{e.victim?.name ?? "?"}</b> <em>+1</em>
                </>
              )}
            </li>
          ))}
      </ol>
      <ol className="pl-bomber-lanes" aria-label="Oyuncular">
        {wire.seats.map((_, lane) => {
          const look = lanes[lane],
            dead = wire.phase === "playing" && !wire.alive[lane] && !wire.out[lane];
          return (
            <li key={lane} className={lane === self ? "is-self" : undefined} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
              <span className="pl-bomber-face" aria-hidden="true">
                {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
              </span>
              <span className="pl-bomber-name">
                {look?.name ?? "Ayrıldı"}
                {lane === self && look?.name !== "Sen" && <small>SEN</small>}
              </span>
              <b className="pl-bomber-score">{wire.score[lane]}</b>
              {(wire.out[lane] || (look && !look.connected) || dead) && (
                <span className="pl-bomber-status">{wire.out[lane] ? "Ayrıldı" : look && !look.connected ? "Bağlantı koptu" : `Dönüyor ${Math.max(1, Math.ceil(wire.respawn[lane] / B.hz))}`}</span>
              )}
            </li>
          );
        })}
      </ol>
      {wire.phase === "countdown" && (
        <div className="pl-bomber-callout" role="status">
          <span>BOMBACI</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>Kutuları patlatıp yol aç, rakibini vur: +1. Kendi bomban −1. 60 saniye.</small>
        </div>
      )}
      {wire.phase === "playing" && step < B.hz * 0.9 && (
        <div className="pl-bomber-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {wire.phase === "playing" && step < B.hz * 8 && self >= 0 && (
        <p className="pl-bomber-hint">
          <kbd>WASD</kbd> yürü · <kbd>{keys}</kbd> bomba
        </p>
      )}
      {wire.phase === "results" && (
        <section className="pl-bomber-results" aria-label="Bombacı sonucu">
          <p>BOMBACI · {wire.broken} kutu kırıldı</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Puan</th>
                <th scope="col">Vuruş</th>
                <th scope="col">Kendi</th>
                <th scope="col">Kutu</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-bomber-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                    {wire.out[lane] && " (ayrıldı)"}
                  </td>
                  <td>{wire.score[lane]}</td>
                  <td>{wire.kills[lane]}</td>
                  <td>{wire.selfKills[lane]}</td>
                  <td>{wire.boxes[lane]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {restart && (
            <button className="pl-button pl-primary" type="button" onClick={restart}>
              Yeniden oyna
            </button>
          )}
          <small>{afterRound}</small>
        </section>
      )}
    </div>
  );
}
