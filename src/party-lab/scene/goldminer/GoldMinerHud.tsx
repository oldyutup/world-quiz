import type { GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";
import { finds, itemsLeft, resultOrder } from "./results";
import "./goldminer.css";

export interface GoldHudLane {
  name: string;
  color: string;
  connected: boolean;
}

export default function GoldMinerHud({ wire, lanes, self, winner, keys, afterRound, restart }: {
  wire: GoldWire;
  lanes: readonly GoldHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  /** "F / Sol Tık": what fires the hook on this device. */
  keys: string;
  afterRound: string;
  /** Yerel Test Arenası: a new mine at once. */
  restart?: () => void;
}) {
  const left = Math.max(0, wire.limit - wire.elapsed / 1000),
    touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    early = wire.phase === "results" && wire.elapsed < wire.limit * 1000 - 20;
  return (
    <div className="pl-gold-hud">
      <ol className="pl-gold-lanes" aria-label="Oyuncular">
        {wire.seats.map((_, lane) => {
          const look = lanes[lane];
          return (
            <li key={lane} className={lane === self ? "is-self" : undefined} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
              <span className="pl-gold-name">
                <i aria-hidden="true" />
                {look?.name ?? "Ayrıldı"}
                {lane === self && look?.name !== "Sen" && <small>SEN</small>}
              </span>
              <b className="pl-gold-score">{wire.score[lane]}</b>
              {(wire.out[lane] || (look && !look.connected)) && <span className="pl-gold-status">{wire.out[lane] ? "Ayrıldı" : "Bağlantı koptu"}</span>}
            </li>
          );
        })}
      </ol>
      {wire.phase !== "results" && (
        <div className={`pl-gold-clock${wire.phase === "mining" && left <= 5 ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(left)}
        </div>
      )}
      {wire.phase === "countdown" && (
        <div className="pl-gold-callout" role="status">
          <span>ALTIN MADENCİ</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>Kanca sallanırken bas, o açıyla fırlar. En çok puanı toplayan kazanır.</small>
        </div>
      )}
      {wire.phase === "mining" && wire.elapsed < 900 && (
        <div className="pl-gold-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {wire.phase !== "results" && self >= 0 && (
        <p className="pl-gold-hint">
          {touch ? "Ekrana dokun" : <>Bas: <kbd>{keys}</kbd></>}: kanca sallanırken fırlat.
        </p>
      )}
      {wire.phase === "results" && (
        <section className="pl-gold-results" aria-label="Maden sonucu">
          <p>ALTIN MADENCİ · {early ? `maden ${(wire.elapsed / 1000).toFixed(1)} sn'de boşaldı` : "süre doldu"}</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Puan</th>
                <th scope="col">Çıkardıkları</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-gold-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                    {wire.out[lane] && " (ayrıldı)"}
                  </td>
                  <td>{wire.score[lane]}</td>
                  <td className="pl-gold-finds">{finds(wire, lane)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!early && itemsLeft(wire) > 0 && <small>Madende {itemsLeft(wire)} eşya kaldı.</small>}
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
