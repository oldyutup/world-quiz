import { BOX_TOWER as T } from "../../../../shared/party-lab/simulation/boxtower/config";
import type { TowerWire } from "../../../../shared/party-lab/simulation/boxtower/wire";
import { timeLeft } from "./source";
import { resultOrder, seconds } from "./results";
import "./tower.css";

export interface TowerHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}

export default function TowerHud({ wire, now, best, lanes, self, winner, keys, afterRound, restart }: {
  wire: TowerWire;
  /** The moment shown, ms after BAŞLA. */
  now: number;
  /** Each lane's tallest column as drawn (a box this screen saw land counts at once). */
  best: readonly number[];
  lanes: readonly TowerHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  /** "Space": what drops the box. */
  keys: string;
  afterRound: string;
  /** Yerel Test Arenası: a new round at once. */
  restart?: () => void;
}) {
  const left = timeLeft(wire, wire.phase === "stacking" ? now : wire.phase === "results" ? wire.elapsed : 0),
    count = wire.seats.length,
    over = wire.phase === "stacking" && now >= wire.limit * 1000;
  return (
    <div className="pl-tower-hud">
      {wire.phase !== "results" && (
        <div className={`pl-tower-clock${left <= 10 ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(left)}
        </div>
      )}
      {/* One card over each yard (the arena sets --pl-tower-x-N once it knows where the yards are). */}
      <ol className="pl-tower-cards" aria-label="Oyuncular">
        {wire.seats.map((_, lane) => {
          const look = lanes[lane],
            height = Math.min(T.goal, best[lane] ?? wire.best[lane]);
          return (
            <li
              key={lane}
              className={lane === self ? "is-self" : undefined}
              style={{ ["--lane" as string]: look?.color ?? "#ccc", left: `clamp(var(--pl-tower-card-min), var(--pl-tower-x-${lane}, ${((lane + 0.5) / count) * 100}%), calc(100% - var(--pl-tower-card-max)))` }}
            >
              <span className="pl-tower-face" aria-hidden="true">
                {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
              </span>
              <span className="pl-tower-name">
                {look?.name ?? "Ayrıldı"}
                {lane === self && look?.name !== "Sen" && <small>SEN</small>}
              </span>
              <b className="pl-tower-score" aria-label={`En yüksek sütun ${height} / ${T.goal}`}>
                {height}
                <small>/{T.goal}</small>
              </b>
              {(wire.out[lane] || (look && !look.connected)) && <span className="pl-tower-status">{wire.out[lane] ? "Ayrıldı" : "Bağlantı koptu"}</span>}
            </li>
          );
        })}
      </ol>
      {wire.phase === "stacking" && self >= 0 && !over && (
        <p className="pl-tower-hint">
          <kbd>{keys}</kbd> kutuyu bırak
        </p>
      )}
      {wire.phase === "countdown" && (
        <div className="pl-tower-callout" role="status">
          <span>KUTU KULESİ</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>
            Kutu kayarken <kbd>{keys}</kbd> ile bırak. Bir sütunda {T.goal} kutuyu ilk dizen kazanır; kule yükseldikçe kutu hızlanır.
          </small>
        </div>
      )}
      {wire.phase === "stacking" && now >= 0 && now < 900 && (
        <div className="pl-tower-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {over && (
        <div className="pl-tower-callout is-over" role="status">
          <strong>SÜRE DOLDU</strong>
        </div>
      )}
      {wire.phase === "results" && (
        <section className="pl-tower-results" aria-label="Kutu Kulesi sonucu">
          <p>KUTU KULESİ · {seconds(wire.elapsed)}</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">En yüksek</th>
                <th scope="col">Ulaştığı an</th>
                <th scope="col">Kutu</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-tower-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                    {wire.out[lane] && " (ayrıldı)"}
                  </td>
                  <td>
                    {wire.best[lane]}/{T.goal}
                  </td>
                  <td>{wire.best[lane] > 0 ? seconds(wire.reached[lane]) : "–"}</td>
                  <td>{wire.placed[lane]}</td>
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
