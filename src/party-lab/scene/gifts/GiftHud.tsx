import { LAYER_FLAG } from "../../../../shared/party-lab/network/protocol";
import { GIFT } from "../../../../shared/party-lab/simulation/gifts/config";
import type { GiftReach } from "../../../../shared/party-lab/simulation/gifts/reach";
import { giftCallout, giftPlaces, giftSecondsLeft } from "./hud";
import type { GiftFrame } from "./source";
import "./gifts.css";

export interface GiftHudLane {
  name: string;
  color: string;
  connected: boolean;
  /** The character's picture ("" none). */
  portrait: string;
}
const REACH_TEXT: Record<GiftReach["kind"], string> = { pile: "kutu al", loose: "kutuyu al", steal: "kutu çal" };

export default function GiftHud({ frame, lanes, reach, keys, afterRound, restart }: {
  frame: GiftFrame;
  /** Per seat. */
  lanes: readonly GiftHudLane[];
  /** What this player's Tut would take now (null: nothing). */
  reach: GiftReach["kind"] | null;
  keys: { pickup: string; punch: string };
  afterRound: string;
  /** Yerel Test Arenası: a new round at once. */
  restart?: () => void;
}) {
  const { gift, phase, self } = frame,
    left = giftSecondsLeft(phase === "playing" ? frame.tick : phase === "results" ? gift.tick : 0),
    callout = phase === "playing" ? giftCallout(gift.events, self) : null,
    carrying = self >= 0 && gift.carrying[self],
    stunned = self >= 0 && gift.stunUntil[self] > frame.tick;
  const places = giftPlaces(gift),
    order = gift.seats.map((_, seat) => seat).sort((a, b) => places[a] - places[b] || a - b);
  return (
    <div className="pl-gift-hud">
      {phase !== "results" && (
        <div className={`pl-gift-clock${left <= 10 && phase === "playing" ? " is-low" : ""}`} role="timer" aria-label="Kalan süre">
          {Math.ceil(phase === "countdown" ? GIFT.round.duration : left)}
        </div>
      )}
      <aside className="pl-gift-side">
        <ol className="pl-gift-lanes" aria-label="Evlerdeki kutular">
          {gift.seats.map((slot, seat) => {
            const look = lanes[seat],
              gone = !!(gift.flags[slot] & LAYER_FLAG.forfeit),
              status = gone ? "Ayrıldı" : look && !look.connected ? "Bağlantı koptu" : gift.stunUntil[slot] > frame.tick ? "Sersem!" : gift.carrying[slot] ? "Kutu taşıyor" : "";
            return (
              <li key={slot} className={slot === self ? "is-self" : undefined} style={{ ["--lane" as string]: look?.color ?? "#ccc" }}>
                <span className="pl-gift-face" aria-hidden="true">
                  {look?.portrait ? <img src={look.portrait} alt="" /> : <i />}
                </span>
                <span className="pl-gift-name">
                  {look?.name ?? "Ayrıldı"}
                  {slot === self && look?.name !== "Sen" && <small>SEN</small>}
                </span>
                <b className="pl-gift-count" aria-label={`${look?.name ?? "Oyuncu"}: evinde ${Math.max(0, gift.home[slot])} kutu`}>
                  {Math.max(0, gift.home[slot])}
                </b>
                {status && <span className="pl-gift-status">{status}</span>}
              </li>
            );
          })}
        </ol>
        {phase !== "results" && (
          <p className="pl-gift-pile" data-empty={gift.pile === 0 || undefined}>
            {gift.pile > 0 ? (
              <>
                Ortada <b>{gift.pile}</b> kutu
              </>
            ) : (
              <>Ortadaki kutular bitti · rakiplerden çal!</>
            )}
          </p>
        )}
        {phase !== "results" && self >= 0 && (
          <p className="pl-gift-hint">
            <kbd>WASD</kbd> yürü · <kbd>{keys.pickup}</kbd> kutu al · <kbd>{keys.punch}</kbd> yumruk
          </p>
        )}
      </aside>
      {phase === "playing" && self >= 0 && (stunned || carrying || reach) && (
        <div className="pl-gift-prompt" data-tone={stunned ? "stun" : carrying ? "carry" : "take"} role="status">
          {stunned ? "Sersemledin!" : carrying ? "Evine götür! Taşırken yumruk atamazsın" : (
            <>
              <kbd>{keys.pickup}</kbd> {REACH_TEXT[reach!]}
            </>
          )}
        </div>
      )}
      {callout && (
        <div key={callout.id} className="pl-gift-callout" data-tone={callout.tone} role="status">
          {callout.text}
        </div>
      )}
      {phase === "countdown" && (
        <div className="pl-gift-banner" role="status">
          <span>HEDİYE KAPMACA</span>
          <strong>{Math.max(1, Math.ceil(frame.countdown))}</strong>
          <small>Ortadan kutu kap, evine götür. Bitince rakiplerin evinden çal; kutu taşıyana yumruk at. 40 saniye.</small>
        </div>
      )}
      {phase === "playing" && frame.tick < 54 && (
        <div className="pl-gift-banner is-go" role="status">
          <strong>BAŞLA!</strong>
        </div>
      )}
      {phase === "results" && (
        <section className="pl-gift-results" aria-label="Hediye Kapmaca sonucu">
          <p>HEDİYE KAPMACA{gift.pileEmptyAt >= 0 ? ` · ortadakiler ${(gift.pileEmptyAt / 60).toFixed(1)} sn'de bitti` : ""}</p>
          <h2>{frame.winner < 0 ? "BERABERE" : frame.winner === self ? "KAZANDIN!" : `${lanes[gift.seats.indexOf(frame.winner)]?.name ?? "Ayrılan oyuncu"} KAZANDI`}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Oyuncu</th>
                <th scope="col">Evdeki kutu</th>
              </tr>
            </thead>
            <tbody>
              {order.map((seat) => {
                const slot = gift.seats[seat];
                return (
                  <tr key={slot} className={slot === self ? "is-self" : undefined}>
                    <td>{places[seat] + 1}.</td>
                    <td>
                      <i className="pl-gift-dot" style={{ background: lanes[seat]?.color ?? "#ccc" }} />
                      {lanes[seat]?.name ?? "Ayrıldı"}
                      {gift.flags[slot] & LAYER_FLAG.forfeit ? " (ayrıldı)" : ""}
                    </td>
                    <td>{Math.max(0, gift.home[slot])}</td>
                  </tr>
                );
              })}
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
