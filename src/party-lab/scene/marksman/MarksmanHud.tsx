import { MARKSMAN as M } from "../../../../shared/party-lab/simulation/marksman/config";
import type { MarksmanWire } from "../../../../shared/party-lab/simulation/marksman/wire";
import { timeLeft, type LaneView } from "./source";
import { points, resultOrder, scoreText } from "./results";
import "./marksman.css";

export interface MarksmanHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}
/** A floating word lasts this long, ms. */
export const POP_MS = 1000;
const WORDS: Readonly<Record<number, string>> = { [M.points.good]: "İYİ!", [M.points.slow]: "YAVAŞ!", [M.points.bomb]: "BUM!" };

export default function MarksmanHud({ wire, now, views, lanes, self, winner, keys, afterRound, restart }: {
  wire: MarksmanWire;
  /** The moment shown, ms after BAŞLA. */
  now: number;
  /** Every lane as drawn (scores with this player's own shots at once, hits for the floating words). */
  views: readonly LaneView[];
  lanes: readonly MarksmanHudLane[];
  self: number;
  /** The round's winning lane, −1 for a draw. */
  winner: number;
  /** "A / D" aims, "SPACE" fires. */
  keys: { aim: string; fire: string };
  afterRound: string;
  /** Yerel Test Arenası: a new round at once. */
  restart?: () => void;
}) {
  const left = timeLeft(wire, wire.phase === "shooting" ? now : wire.phase === "results" ? wire.elapsed : 0),
    count = wire.seats.length,
    over = wire.phase === "shooting" && now >= wire.limit * 1000;
  const pops = wire.phase === "results" ? [] : views.flatMap((v, lane) => v.hits.filter((h) => now - h.at >= -20 && now - h.at < POP_MS).map((h) => ({ lane, ...h })));
  return (
    <div className="pl-mm-hud">
      {wire.phase !== "results" && (
        <div className={`pl-mm-clock${left <= 10 ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(left)}
        </div>
      )}
      {/* One card over each player's stretch (the arena sets --pl-mm-x-N once it knows where they are). */}
      <ol className="pl-mm-cards" aria-label="Oyuncular">
        {wire.seats.map((_, lane) => {
          const look = lanes[lane],
            v = views[lane],
            score = v?.score ?? wire.score[lane],
            stunned = wire.phase === "shooting" && now < (v?.stunUntil ?? 0);
          return (
            <li
              key={lane}
              className={`${lane === self ? "is-self" : ""}${stunned ? " is-stunned" : ""}`}
              style={{ ["--lane" as string]: look?.color ?? "#ccc", left: `clamp(var(--pl-mm-card-min), var(--pl-mm-x-${lane}, ${((lane + 0.5) / count) * 100}%), calc(100% - var(--pl-mm-card-max)))` }}
            >
              <span className="pl-mm-face" aria-hidden="true">
                {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
              </span>
              <span className="pl-mm-name">
                {look?.name ?? "Ayrıldı"}
                {lane === self && look?.name !== "Sen" && <small>SEN</small>}
              </span>
              <b className="pl-mm-score" aria-label={`Puan ${score}`}>
                {scoreText(score)}
              </b>
              {(wire.out[lane] || (look && !look.connected)) && <span className="pl-mm-status">{wire.out[lane] ? "Ayrıldı" : "Bağlantı koptu"}</span>}
              {stunned && !wire.out[lane] && <span className="pl-mm-status is-stun">SERSEM</span>}
            </li>
          );
        })}
      </ol>
      <div className="pl-mm-pops" aria-hidden="true">
        {pops.map((p) => (
          <span
            key={`${p.lane}:${p.wave}:${p.slot}`}
            className={`pl-mm-pop${p.points === M.points.bomb ? " is-bomb" : p.points === M.points.good ? " is-good" : " is-slow"}`}
            style={{ ["--lane" as string]: lanes[p.lane]?.color ?? "#fff", left: `var(--pl-mm-x-${p.lane}-${p.slot}, 50%)`, top: "var(--pl-mm-y, 40%)" }}
          >
            <b>{points(p.points)}</b> {WORDS[p.points] ?? ""}
          </span>
        ))}
      </div>
      {wire.phase === "shooting" && self >= 0 && !over && (
        <p className="pl-mm-hint">
          <kbd>{keys.aim}</kbd> nişan · <kbd>{keys.fire}</kbd> ateş
        </p>
      )}
      {wire.phase === "countdown" && (
        <div className="pl-mm-callout" role="status">
          <span>NİŞANCI</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>
            <kbd>{keys.aim}</kbd> ile sola/sağa nişan al, <kbd>{keys.fire}</kbd> ile ateş et. Hızlı vuruş +{M.points.good}, geç vuruş +{M.points.slow}; bombayı vurma: {points(M.points.bomb)} ve sersemlersin.
          </small>
        </div>
      )}
      {wire.phase === "shooting" && now >= 0 && now < 900 && (
        <div className="pl-mm-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {over && (
        <div className="pl-mm-callout is-over" role="status">
          <strong>SÜRE DOLDU</strong>
        </div>
      )}
      {wire.phase === "results" && (
        <section className="pl-mm-results" aria-label="Nişancı sonucu">
          <p>NİŞANCI · {wire.limit} SN</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Puan</th>
                <th scope="col">İyi</th>
                <th scope="col">Yavaş</th>
                <th scope="col">Bomba</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-mm-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                    {wire.out[lane] && " (ayrıldı)"}
                  </td>
                  <td>
                    <b>{scoreText(wire.score[lane])}</b>
                  </td>
                  <td>{wire.good[lane]}</td>
                  <td>{wire.slow[lane]}</td>
                  <td>{wire.bombs[lane]}</td>
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
