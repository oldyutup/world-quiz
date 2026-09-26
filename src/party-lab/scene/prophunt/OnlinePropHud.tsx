import type { MutableRefObject } from "react";
import { PROP_FAMILIES } from "../../../../shared/party-lab/maps/propHuntProps";
import { PROP_HUNT } from "../../../../shared/party-lab/simulation/prophunt/config";
import { PLAYERS, type PlayerId } from "../players";
import type { PropHudElements, PropSnapshot } from "./PropHuntPlayground";
import { revealLabel } from "./reveal";

const ROLE_NAMES = { seeker: "Arayan", hider: "Saklanan" } as const;

/**
 * Online Saklambaç HUD on the immersive arena, only what the round needs:
 * - the player cards (role, and for hiders only "Saklanıyor" / "Bulundu": never a hint of where);
 * - the phase chip (Saklanma / Arama, the time left and its bar, written per frame into `hud`);
 * - the seeker's crosshair (a red X when the body's line to it is blocked), ammo pips and hiders
 *   left; the hider's disguise chip and the E prompt (per frame);
 * - the seeker's hunch (a hider close by for a moment): "Yakınlarda biri var..." and an even glow
 *   round the edge that fade within 2 s — never who, which prop, which way or how far;
 * - the seeker's blindfold during the hiding phase, the big calls ("BULUNDU!", "Boş!"),
 *   and the countdown / found / result messages;
 * - at the result, a label over each hider still hidden ("Bulunamadı: Player 2 · Sandalye",
 *   placed per frame over its prop, through walls: the round is over).
 * The debug readout exists only when the Esc debug panel is open (`?partyDebug=1`).
 */
export default function OnlinePropHud({ snapshot, hud, debugOpen, slot, names, ammoMax, proximity, whistleSeconds }: { snapshot: PropSnapshot; hud: MutableRefObject<PropHudElements>; debugOpen: boolean; slot: PlayerId; names: string[]; ammoMax: number; proximity: boolean; whistleSeconds: number }) {
  const { phase, role } = snapshot;
  const seeker = role === "seeker";
  const out = !seeker && !snapshot.alive[slot] && phase === "search";
  const status = (id: PlayerId) => (snapshot.roles[id] === "seeker" ? (phase === "hiding" ? "Gözleri kapalı" : phase === "search" ? "Arıyor" : "Hazır") : snapshot.alive[id] ? "Saklanıyor" : "Bulundu");
  const hunting = phase === "hiding" || phase === "search";
  return (
    <>
      <div className="pl-round-hud">
        <ul className="pl-roster" aria-label="Oyuncu durumları">
          {PLAYERS.map((player) => (
            <li key={player.id} className={snapshot.roles[player.id] === "hider" && !snapshot.alive[player.id] ? "pl-eliminated" : ""} data-role={snapshot.roles[player.id]}>
              <span className="pl-player-dot" style={{ backgroundColor: player.color }} aria-hidden="true" />
              <span>
                <b>
                  {names[player.id]} <small>{player.id === slot ? "Sen" : ""}</small>
                </b>
                <span className="pl-prop-status">
                  <i data-role={snapshot.roles[player.id]}>{ROLE_NAMES[snapshot.roles[player.id]]}</i> {status(player.id)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {hunting && (
        <div className="pl-prop-chip" data-phase={phase} data-role={role} role="status" aria-live="polite">
          <span className="pl-prop-chip-name">
            <b>{phase === "hiding" ? "Saklanma" : "Arama"}</b>
            <small>
              {phase === "hiding"
                ? seeker
                  ? "Gözlerin kapalı, bekle"
                  : "Bir eşyanın yanına git, E ile ona dönüş"
                : seeker
                ? `${snapshot.hidden} saklanan kaldı`
                : snapshot.alive[slot]
                ? "Kıpırdama, arayan geliyor"
                : "İzliyorsun"}
            </small>
          </span>
          <span className="pl-prop-time" ref={(element) => void (hud.current.timer = element)} />
          <span className="pl-prop-bar" aria-hidden="true">
            <span ref={(element) => void (hud.current.bar = element)} />
          </span>
        </div>
      )}
      <div className="pl-crosshair pl-prop-crosshair" aria-hidden="true" data-shown="false" ref={(element) => void (hud.current.crosshair = element)} />
      {seeker && hunting && (
        <div className="pl-prop-ammo" aria-label={`Mermi: ${snapshot.ammo} / ${ammoMax}`} data-empty={snapshot.ammo === 0 || undefined}>
          <span className="pl-prop-pips" aria-hidden="true">
            {Array.from({ length: ammoMax }, (_, k) => (
              <i key={k} data-full={k < snapshot.ammo || undefined} />
            ))}
          </span>
          <b>
            {snapshot.ammo}
            <small>/{ammoMax}</small>
          </b>
          <span className="pl-prop-ammo-note">{snapshot.ammo === 0 ? "Mermi bitti" : "Yeniden doldurma yok"}</span>
        </div>
      )}
      {!seeker && hunting && snapshot.alive[slot] && (
        <div className="pl-prop-disguise" data-worn={snapshot.disguise ? "true" : "false"}>
          <span className="pl-prop-disguise-name">
            <small>Kılık</small>
            <b>{snapshot.disguise ? PROP_FAMILIES[snapshot.disguise].name : "Yok"}</b>
          </span>
          {phase === "search" && <span className="pl-prop-whistle">Q · Islık {whistleSeconds > 0 ? `(${whistleSeconds} sn)` : "hazır"}</span>}
          <span className="pl-prop-prompt" data-ready="false" ref={(element) => void (hud.current.prompt = element)} />
        </div>
      )}
      <div className="pl-prop-callout" aria-hidden="true" ref={(element) => void (hud.current.callout = element)} />
      {PLAYERS.map((player) => {
        const shown = snapshot.reveal.find((r) => r.id === player.id);
        return (
          <div key={player.id} className="pl-prop-reveal" data-shown="false" aria-hidden="true" ref={(element) => void (hud.current.reveals[player.id] = element)}>
            {shown && (
              <>
                <span>Bulunamadı:</span> <b style={{ color: player.color }}>{names[player.id]}</b> · <b>{revealLabel(player.id, shown.family).what}</b>
              </>
            )}
          </div>
        );
      })}
      {seeker && proximity && (
        <>
          <div className="pl-prop-sense-glow" aria-hidden="true" ref={(element) => void (hud.current.senseGlow = element)} />
          <div className="pl-prop-sense" aria-hidden="true" ref={(element) => void (hud.current.sense = element)}>
            Yakınlarda biri var...
          </div>
        </>
      )}
      <div className="pl-prop-blind" data-shown="false" role="status" ref={(element) => void (hud.current.blind = element)}>
        <strong ref={(element) => void (hud.current.blindTime = element)} />
        <span>Gözlerin kapalı. Saklananlar gizleniyor…</span>
      </div>
      {debugOpen && <div className="pl-arena-side">
        <div className="pl-debug-panel" hidden={!debugOpen} aria-hidden="true">
          <pre className="pl-prop-debug" ref={(element) => void (hud.current.debug = element)} />
        </div>
      </div>
      }
      {out && snapshot.spectating !== null && (
        <div className="pl-layer-spectate" role="status">
          İzleniyor: <b style={{ color: PLAYERS[snapshot.spectating].color }}>{names[snapshot.spectating]}</b>
          <span> · Q / E değiştir</span>
        </div>
      )}
      {(phase === "countdown" || phase === "results" || out) && (
        <div className={`pl-arena-message pl-round-message${phase === "results" ? " pl-result-pulse" : ""}`} role="status" aria-atomic="true">
          {phase === "countdown" && (
            <>
              <strong>{snapshot.seconds}</strong>
              <span>
                {seeker
                  ? `Sen arayansın. ${PROP_HUNT.timing.hiding} sn gözlerin kapalı; sonra ${ammoMax} atışla iki saklananı bul. Boşa atış mermini yer.`
                  : `Sen saklanansın. ${PROP_HUNT.timing.hiding} sn içinde bir eşyanın yanına git ve E ile ona dönüş. Arayan ${PROP_HUNT.timing.search} sn arayacak.`}
              </span>
            </>
          )}
          {out && (
            <>
              <strong>Bulundun!</strong>
              <span>{snapshot.hidden > 0 ? "Takım arkadaşın hâlâ saklanıyor. İzle." : "Diğerlerini izle."}</span>
            </>
          )}
          {phase === "results" && (
            <>
              <strong data-outcome={snapshot.outcome ?? undefined}>{snapshot.outcome === (seeker ? "seeker" : "hiders") ? "Kazandın!" : snapshot.outcome === "seeker" ? "Arayan kazandı!" : "Saklananlar kazandı!"}</strong>
              <span>
                {snapshot.reason === "found"
                  ? `İki saklanan da ${snapshot.endedAt.toFixed(1)} sn'de bulundu. `
                  : snapshot.reason === "ammo"
                  ? `${seeker ? "Mermin bitti!" : "Arayanın mermisi bitti!"} ${snapshot.hidden} saklanan bulunamadı. `
                  : snapshot.reason === "forfeit" ? "Oyuncu ayrıldı. " : `Süre doldu, ${snapshot.hidden} saklanan bulunamadı. `}
                Yeni tur için lobiye dönülüyor.
              </span>
              {snapshot.reveal.map((r) => (
                <em key={r.id} className="pl-prop-result-line">
                  Bulunamadı: <b style={{ color: PLAYERS[r.id].color }}>{names[r.id]}</b> · {revealLabel(r.id, r.family).what}
                </em>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
