import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";
import { RHYTHM_STYLES, RHYTHM_STYLE_NAMES } from "../../../../shared/party-lab/simulation/rhythm/song";
import { timeLeft, type RhythmFrame } from "./source";
import { KEY_COLORS } from "./lanes";
import { comboScale, laneOrder, resultOrder } from "./hud";
import "./rhythm.css";

export interface RhythmHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}

/**
 * Ritim Ustası HUD: the lanes block at the bottom (this player's lane first and biggest, each
 * with its card: picture, name, score and the combo growing beside it; the arena draws the
 * notes into each lane's canvas), the clock and the song's style top right, the countdown with
 * the rules, and the results with every player's longest combo and its bonus.
 */
export default function RhythmHud({ frame, lanes, labels, afterRound, restart }: {
  frame: RhythmFrame;
  lanes: readonly RhythmHudLane[];
  /** What the four notes say ("W", "A", "S", "D" by default). */
  labels: readonly string[];
  afterRound: string;
  /** Yerel Test Arenası: a new round at once. */
  restart?: () => void;
}) {
  const { wire, now, self, winner } = frame,
    left = timeLeft(wire, wire.phase === "playing" ? now : wire.phase === "results" ? wire.elapsed : 0),
    style = RHYTHM_STYLE_NAMES[RHYTHM_STYLES[wire.style]],
    over = wire.phase === "playing" && now >= frame.song.endAt + 1200;
  const keys = (
    <span className="pl-rh-keys">
      {labels.map((label, key) => (
        <kbd key={key} style={{ ["--key" as string]: KEY_COLORS[key] }}>
          {label}
        </kbd>
      ))}
    </span>
  );
  return (
    <div className="pl-rh-hud">
      {wire.phase !== "results" && (
        <div className="pl-rh-top">
          <span className="pl-rh-style" aria-label="Müzik tarzı">
            ♪ {style}
          </span>
          <div className={`pl-rh-clock${left <= 10 ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
            {Math.ceil(left)}
          </div>
        </div>
      )}
      <ol className="pl-rh-lanes" aria-label="Şeritler">
        {laneOrder(wire.seats.length, self).map((lane) => {
          const look = lanes[lane],
            view = frame.lanes[lane],
            combo = view?.combo ?? 0;
          return (
            <li key={lane} className={`pl-rh-row${lane === self ? " is-self" : ""}${wire.out[lane] ? " is-out" : ""}`} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
              <div className="pl-rh-card">
                <span className="pl-rh-face" aria-hidden="true">
                  {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
                </span>
                <span className="pl-rh-who">
                  <span className="pl-rh-name">
                    {look?.name ?? "Ayrıldı"}
                    {lane === self && look?.name !== "Sen" && <small>SEN</small>}
                  </span>
                  {wire.out[lane] || (look && !look.connected) ? <span className="pl-rh-status">{wire.out[lane] ? "Ayrıldı" : "Bağlantı koptu"}</span> : <b className="pl-rh-score" aria-label={`Puan ${view?.score ?? 0}`}>{view?.score ?? 0}</b>}
                </span>
                <span className={`pl-rh-combo${combo >= 2 ? " is-on" : ""}`} aria-label={`Kombo ${combo}`} style={{ ["--combo-scale" as string]: comboScale(combo) }}>
                  <b key={combo}>{combo >= 2 ? `×${combo}` : ""}</b>
                  <small>{combo >= 2 ? "KOMBO" : ""}</small>
                </span>
              </div>
              <div className="pl-rh-trackbox">
                <canvas className="pl-rh-track" data-rh-lane={lane} aria-hidden="true" />
              </div>
            </li>
          );
        })}
      </ol>
      {frame.mismatch && (
        <p className="pl-rh-warning" role="alert">
          Bu sayfanın şarkısı sunucununkiyle uyuşmuyor. Sayfayı yenile.
        </p>
      )}
      {wire.phase === "playing" && self >= 0 && now >= 0 && now < 6000 && (
        <p className="pl-rh-hint">
          Nota çembere gelince {keys} (ya da oklar)
        </p>
      )}
      {wire.phase === "countdown" && (
        <div className="pl-rh-callout" role="status">
          <span>RİTİM USTASI</span>
          <strong>{Math.max(1, Math.ceil(wire.countdown))}</strong>
          <small>
            Nota çembere geldiği anda üstündeki tuşa bas {keys}
            <br />
            Tam zamanında +{R.points.perfect}, biraz erken ya da geç +{R.points.good}. Iskalamak, yanlış tuş ya da boşa basmak komboyu sıfırlar; en uzun kombonun {R.comboBonus} katı sonda bonus.
          </small>
        </div>
      )}
      {wire.phase === "playing" && now >= 0 && now < 900 && (
        <div className="pl-rh-callout is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {over && (
        <div className="pl-rh-callout is-over" role="status">
          <strong>ŞARKI BİTTİ</strong>
        </div>
      )}
      {wire.phase === "results" && (
        <section className="pl-rh-results" aria-label="Ritim Ustası sonucu">
          <p>RİTİM USTASI · ♪ {style}</p>
          <h2>{winner < 0 ? "BERABERE" : winner === self ? "KAZANDIN!" : `${lanes[winner]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Mükemmel</th>
                <th scope="col">İyi</th>
                <th scope="col">Kaçan</th>
                <th scope="col">Puan</th>
                <th scope="col">En uzun kombo</th>
                <th scope="col">Bonus</th>
                <th scope="col">Toplam</th>
              </tr>
            </thead>
            <tbody>
              {resultOrder(wire).map((lane) => (
                <tr key={lane} className={lane === self ? "is-self" : undefined}>
                  <td>{wire.places[lane] + 1}.</td>
                  <td>
                    <i className="pl-rh-dot" style={{ background: lanes[lane]?.color ?? "#ccc" }} />
                    {lanes[lane]?.name ?? "Ayrıldı"}
                    {wire.out[lane] && " (ayrıldı)"}
                  </td>
                  <td>{wire.perfect[lane]}</td>
                  <td>{wire.good[lane]}</td>
                  <td>{wire.miss[lane] + wire.wrong[lane]}</td>
                  <td>{wire.score[lane]}</td>
                  <td>{wire.maxCombo[lane]}</td>
                  <td>+{wire.bonus[lane]}</td>
                  <td>
                    <b>{wire.total[lane]}</b>
                  </td>
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
