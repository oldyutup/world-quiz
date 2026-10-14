import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { RUSH_AT } from "../../../../shared/party-lab/simulation/trails/game";
import { trainState } from "../../../../shared/party-lab/simulation/trails/train";
import type { TrailWire } from "../../../../shared/party-lab/simulation/trails/wire";
import { causeText, outAt, resultOrder, secondsLeft } from "./hud";
import "./trails.css";

export interface TrailHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}

export default function TrailHud({ wire, step, lanes, self, winner, afterRound, restart }: {
  wire: TrailWire;
  /** Play step shown (fractional). */
  step: number;
  lanes: readonly TrailHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  afterRound: string;
  /** Yerel Test Arenası: a new round at once. */
  restart?: () => void;
}) {
  const playing = wire.phase === "playing",
    shown = playing ? step : wire.step,
    left = secondsLeft(wire, shown),
    rush = playing && step > RUSH_AT,
    train = trainState(playing ? step : -1),
    names = lanes.map((l) => l.name),
    selfOut = self >= 0 && playing && !wire.alive[self];
  return (
    <div className="pl-trail-hud">
      {wire.phase !== "results" && (
        <div className={`pl-trail-clock${rush ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(left)}
        </div>
      )}
      {rush && (
        <p className="pl-trail-rush" role="status">
          Hızlanma ×1,3
        </p>
      )}
      {/* The left column: who is still running, the train, the keys (the arena keeps the rest). */}
      <aside className="pl-trail-side">
        <ol className="pl-trail-lanes" aria-label="Oyuncular">
          {wire.seats.map((_, lane) => {
            const look = lanes[lane],
              out = !wire.alive[lane] && wire.phase !== "countdown",
              status = out ? causeText(wire, lane, names) : wire.phase === "results" ? (lane === winner ? "Kazandı" : "Hayatta") : look && !look.connected ? "Bağlantı koptu" : wire.phase === "countdown" ? "Hazır" : "Koşuyor";
            return (
              <li key={lane} className={`${lane === self ? "is-self" : ""}${out ? " is-out" : ""}`} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
                <span className="pl-trail-face" aria-hidden="true">
                  {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
                </span>
                <span className="pl-trail-name">
                  {look?.name ?? "Ayrıldı"}
                  {lane === self && look?.name !== "Sen" && <small>SEN</small>}
                </span>
                <span className="pl-trail-status">{status}</span>
              </li>
            );
          })}
        </ol>
        {wire.phase !== "results" && (
          <div className={`pl-trail-train is-${playing ? train.phase : "wait"}`} role="status" aria-label="Tren">
            {!playing || train.phase === "wait" ? (
              <>
                <span>Tren</span>
                <b>{Math.ceil(playing ? train.until : L.train.first)} sn</b>
                <i style={{ ["--fill" as string]: `${Math.max(0, Math.min(1, 1 - (playing ? train.until : L.train.first) / L.train.every)) * 100}%` }} />
              </>
            ) : train.phase === "warn" ? (
              <>
                <span>Tren geliyor!</span>
                <b>
                  {train.dir > 0 ? "→" : "←"} {Math.ceil(train.until)}
                </b>
              </>
            ) : train.phase === "run" ? (
              <span>Tren geçiyor</span>
            ) : (
              <span>Son tren geçti</span>
            )}
          </div>
        )}
        {wire.phase !== "results" && self >= 0 && (
          <p className="pl-trail-hint">
            <kbd>WASD</kbd> ya da <kbd>oklar</kbd>: yön
          </p>
        )}
      </aside>
      {wire.phase === "countdown" && (
        <div className="pl-trail-callout" role="status">
          <span>IŞIK İZİ</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>Hiç durmadan koşarsın. İzlere, duvarlara ve trene çarpma. Son kalan kazanır.</small>
        </div>
      )}
      {playing && step < L.hz * 0.9 && (
        <div className="pl-trail-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {playing && step > RUSH_AT && step < RUSH_AT + L.hz * 1.4 && !selfOut && (
        <div className="pl-trail-callout is-rush" role="status">
          <strong>HIZLANMA!</strong>
        </div>
      )}
      {selfOut && (
        <div className="pl-trail-callout is-out" role="status">
          <strong>ELENDİN</strong>
          <small>{causeText(wire, self, names)}</small>
        </div>
      )}
      {wire.phase === "results" && (
        <section className="pl-trail-results" aria-label="Işık İzi sonucu">
          <p>
            IŞIK İZİ · {(wire.step / L.hz).toFixed(1).replace(".", ",")} sn{wire.trainKills ? ` · tren ${wire.trainKills} kişiyi ezdi` : ""}
          </p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Durum</th>
                <th scope="col">Neden</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-trail-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                  </td>
                  <td>{wire.alive[lane] ? (lane === winner ? "Kazandı" : "Hayatta") : outAt(wire, lane)}</td>
                  <td>{wire.alive[lane] ? "" : causeText(wire, lane, names)}</td>
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
