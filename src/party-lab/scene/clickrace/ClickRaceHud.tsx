import type { ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";
import { averageRate, resultOrder } from "./results";
import "./clickrace.css";

export interface ClickHudLane {
  name: string;
  color: string;
  connected: boolean;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} sn`;
const percent = (wire: ClickWire, lane: number) => Math.min(100, Math.floor((wire.clicks[lane] / wire.track) * 100));

export default function ClickRaceHud({ wire, lanes, self, winner, keys, afterRound }: {
  wire: ClickWire;
  lanes: readonly ClickHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  /** "F / Sol Tık" — what presses the pedal on this device. */
  keys: string;
  afterRound: string;
}) {
  const left = Math.max(0, wire.limit - wire.elapsed / 1000),
    touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return (
    <div className="pl-click-hud">
      <ol className="pl-click-lanes" aria-label="Oyuncular">
        {wire.seats.map((_, lane) => {
          const look = lanes[lane];
          const status = wire.out[lane] ? "Ayrıldı" : wire.finish[lane] >= 0 ? `Bitirdi · ${seconds(wire.finish[lane])}` : look && !look.connected ? "Bağlantı koptu" : `${wire.rate[lane]} tık/sn`;
          return (
            <li key={lane} className={lane === self ? "is-self" : undefined} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
              <span className="pl-click-name">
                <i aria-hidden="true" />
                {look?.name ?? "Ayrıldı"}
                {lane === self && <small>SEN</small>}
              </span>
              <span className="pl-click-stats">
                <b>%{percent(wire, lane)}</b>
                <span>{status}</span>
              </span>
              <span className="pl-click-bar" aria-hidden="true">
                <span style={{ width: `${percent(wire, lane)}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      {wire.phase === "racing" && <div className="pl-click-clock" role="timer">{Math.ceil(left)}</div>}
      {wire.phase === "countdown" && (
        <div className="pl-click-callout" role="status">
          <span>TIKLAMA YARIŞI</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>Her basış bir adım. Bitişe ilk varan kazanır.</small>
        </div>
      )}
      {wire.phase === "racing" && wire.elapsed < 1000 && (
        <div className="pl-click-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {wire.phase !== "results" && self >= 0 && (
        <p className="pl-click-hint">
          {touch ? "Ekrana dokun" : <>Bas: <kbd>{keys}</kbd></>}. Basılı tutmak sayılmaz.
        </p>
      )}
      {wire.phase === "results" && (
        <section className="pl-click-results" aria-label="Yarış sonucu">
          <p>TIKLAMA YARIŞI</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Süre</th>
                <th scope="col">Ort.</th>
                <th scope="col">En yüksek</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-click-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                  </td>
                  <td>{wire.finish[lane] >= 0 ? seconds(wire.finish[lane]) : wire.out[lane] ? `Ayrıldı · %${percent(wire, lane)}` : `Bitiremedi · %${percent(wire, lane)}`}</td>
                  <td>{averageRate(wire, lane).toFixed(1)} tık/sn</td>
                  <td>{wire.peak[lane]} tık/sn</td>
                </tr>
              ))}
            </tbody>
          </table>
          <small>{afterRound}</small>
        </section>
      )}
    </div>
  );
}
