import { PartyAudio } from "./audio/PartyAudio";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import ControlsSettings from "./ControlsSettings";
import { loadControls, saveControls } from "./input/storage";
import type { Bindings } from "./input/bindings";
import PartyLobby from "./PartyLobby";
import CostumePreview from "./CostumePreview";
import { loadSelectedCostume, saveSelectedCostume } from "./scene/visual/costumeStorage";
import { COSTUME_NAMES, SELECTABLE_COSTUME_IDS, type SelectableCostumeId } from "./scene/visual/costumes";
import { useLobbySession } from "./network/session";
import { normalizeNickname, normalizeRoomCode, validNickname, validRoomCode } from "./network/types";
import "./party-lab.css";

const PREVIEW_MESSAGE = "Arkadaşlarınla buluş, hazır ol ve aynı arenada kapış. 2–3 oyuncu.";
const OnlineArena = lazy(() => import("./scene/OnlineArena"));
const ArenaScene = lazy(() => import("./scene/ArenaScene"));

export default function PartyLabRoot() {
  return <PartyAudio><PartyLab /></PartyAudio>;
}

function PartyLab() {
  const [inArena, setInArena] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [bindings, setBindings] = useState(loadControls);
  const [controlsSaved, setControlsSaved] = useState(true);
  const controlsEntry = useRef<HTMLButtonElement>(null);
  const network = useLobbySession();
  const updateBindings = useCallback((next: Bindings) => {
    setBindings(next);
    setControlsSaved(saveControls(next));
  }, []);
  const settings = controlsOpen ? <ControlsSettings bindings={bindings} onChange={updateBindings}
    saved={controlsSaved} inArena={inArena || (!!network.snapshot.code && network.snapshot.phase !== "waiting")} online={!!network.snapshot.code && network.snapshot.phase !== "waiting"} onClose={() => {
      setControlsOpen(false);
      requestAnimationFrame(() => controlsEntry.current?.focus());
    }} /> : null;
  const [nickname, setNickname] = useState("");
  const [costumeId, setCostumeId] = useState<SelectableCostumeId>(loadSelectedCostume);
  const [roomCode, setRoomCode] = useState(() => normalizeRoomCode(new URLSearchParams(window.location.search).get("room") ?? ""));
  const [nicknameError, setNicknameError] = useState("");
  const [roomCodeError, setRoomCodeError] = useState("");
  const [status, setStatus] = useState(PREVIEW_MESSAGE);
  const nicknameRef = useRef<HTMLInputElement>(null);
  const roomCodeRef = useRef<HTMLInputElement>(null);
  const busy = network.snapshot.status === "connecting";

  function chooseCostume(next: SelectableCostumeId) {
    setCostumeId(next);
    saveSelectedCostume(next);
  }
  function cycleCostume(step: -1 | 1) {
    const index = SELECTABLE_COSTUME_IDS.indexOf(costumeId);
    chooseCostume(SELECTABLE_COSTUME_IDS[(index + step + SELECTABLE_COSTUME_IDS.length) % SELECTABLE_COSTUME_IDS.length]);
  }

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Party Lab | Torble";
    // Private test: keep the page out of search results (the host also sends X-Robots-Tag).
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.appendChild(robots);
    return () => { document.title = previousTitle; robots.remove(); };
  }, []);

  function handleAction(action: "create" | "join") {
    if (busy) return;
    const name = normalizeNickname(nickname);
    const code = normalizeRoomCode(roomCode);
    const nameError = validNickname(name)
      ? ""
      : "3–16 karakter kullan: harf, rakam, alt çizgi veya kısa çizgi.";
    const codeError = action === "join" && !validRoomCode(code)
      ? "6 karakterlik oda kodunu gir. I, O, 0 ve 1 kodlarda yer almaz."
      : "";

    setNicknameError(nameError);
    setRoomCodeError(codeError);
    if (nameError || codeError) {
      setStatus(PREVIEW_MESSAGE);
      (nameError ? nicknameRef : roomCodeRef).current?.focus();
      return;
    }

    setNickname(name);
    setRoomCode(code);
    void network.connect(action, name, code, costumeId);
  }

  if (network.snapshot.code) {
    const leave = () => { setRoomCode(network.snapshot.code); network.leave(); setControlsOpen(false); setStatus(PREVIEW_MESSAGE); };
    return <>
      <div hidden={controlsOpen}>
        {network.snapshot.phase === 'waiting'
          ? <PartyLobby controlsRef={controlsEntry} lobby={network.snapshot} onChat={network.sendChat} onLeave={leave} onReady={network.setReady} onControls={() => setControlsOpen(true)} diagnostics={network.diagnostics} debug={network.debug} />
          : <Suspense fallback={<div className="party-lab pl-arena-loading"><p role="status">Online arena hazırlanıyor…</p><button onClick={leave}>Odadan Ayrıl</button></div>}>
              <OnlineArena lobby={network.snapshot} stream={network.stream} sendInput={network.sendInput} bindings={bindings} paused={controlsOpen} onControls={() => setControlsOpen(true)} onLeave={leave} diagnostics={network.diagnostics} debug={network.debug}/>
            </Suspense>}
      </div>
      {settings}
    </>;
  }

  if (inArena) {
    return (
      <Suspense fallback={
        <div className="party-lab pl-arena-loading">
          <p role="status">Yerel arena hazırlanıyor…</p>
          <button className="pl-button pl-join" onClick={() => setInArena(false)}>Lobiye Dön</button>
        </div>
      }>
        <div hidden={controlsOpen}>
          <ArenaScene onExit={() => setInArena(false)} bindings={bindings} paused={controlsOpen} onControls={() => setControlsOpen(true)} costumeId={costumeId} />
        </div>
        {settings}
      </Suspense>
    );
  }

  if (settings) return settings;

  return (
    <div className="party-lab pl-landing">
      <header className="pl-topbar">
        <span className="pl-brand">torble<span className="pl-brand-divider">/</span>party lab</span>
        <a className="pl-back" href="/"><span aria-hidden="true">↗</span> Torble'a Dön</a>
      </header>

      <main className="pl-main">
        <section className="pl-intro" aria-labelledby="pl-title">
          <span className="pl-eyebrow">Biraz rekabet. Biraz kaos.</span>
          <h1 id="pl-title">PARTY <span>LAB</span></h1>
          <p className="pl-subtitle">Deneysel, 3 kişilik tarayıcı parti oyunu.</p>
          <div className="pl-costume-picker" aria-label="Kostüm seç">
            <span className="pl-eyebrow">Kostümün</span>
            <CostumePreview costumeId={costumeId} />
            <div className="pl-costume-switch">
              <button type="button" aria-label="Önceki kostüm" disabled={busy} onClick={() => cycleCostume(-1)}>←</button>
              <strong aria-live="polite">{COSTUME_NAMES[costumeId]}</strong>
              <button type="button" aria-label="Sonraki kostüm" disabled={busy} onClick={() => cycleCostume(1)}>→</button>
            </div>
            <div className="pl-costume-options" aria-label="Kostümler">
              {SELECTABLE_COSTUME_IDS.map(id => <button key={id} type="button" aria-label={COSTUME_NAMES[id]}
                aria-pressed={costumeId === id} disabled={busy} onClick={() => chooseCostume(id)}>{COSTUME_NAMES[id]}</button>)}
            </div>
          </div>
        </section>

        <section className="pl-lobby" aria-labelledby="pl-lobby-title">
          <div className="pl-lobby-heading">
            <span className="pl-eyebrow">Arkadaş lobisi</span>
            <span className="pl-badge">DENEYSEL</span>
          </div>
          <h2 id="pl-lobby-title">Partiye adını yaz.</h2>
          <p className="pl-lobby-description">Hesap gerekmez. Bir takma ad yeter.</p>

          <form noValidate onSubmit={event => { event.preventDefault(); handleAction("create"); }}>
            <label htmlFor="pl-nickname">Takma adın</label>
            <input
              ref={nicknameRef}
              id="pl-nickname"
              name="nickname"
              autoComplete="nickname"
              placeholder="Sana ne diyelim?"
              maxLength={16}
              disabled={busy}
              spellCheck={false}
              value={nickname}
              aria-invalid={!!nicknameError}
              aria-describedby="pl-nickname-hint pl-nickname-error"
              onChange={event => {
                setNickname(event.target.value);
                setNicknameError("");
                setStatus(PREVIEW_MESSAGE);
              }}
            />
            <p className="pl-hint" id="pl-nickname-hint">3–16 karakter · Harf, rakam, _ veya -</p>
            <p className="pl-error" id="pl-nickname-error" aria-live="polite">{nicknameError}</p>
            <button className="pl-button pl-create" data-sfx="uiConfirm" type="submit" disabled={busy}>Oda Oluştur <span aria-hidden="true">↗</span></button>
          </form>

          <div className="pl-divider"><span>ya da kodla katıl</span></div>

          <form noValidate onSubmit={event => { event.preventDefault(); handleAction("join"); }}>
            <label htmlFor="pl-room-code">Oda kodu</label>
            <div className="pl-join-row">
              <input
                ref={roomCodeRef}
                id="pl-room-code"
                name="roomCode"
                className="pl-code"
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="ABC234"
                maxLength={6}
                disabled={busy}
                spellCheck={false}
                value={roomCode}
                aria-invalid={!!roomCodeError}
                aria-describedby="pl-room-error"
                onChange={event => {
                  setRoomCode(event.target.value.toUpperCase());
                  setRoomCodeError("");
                  setStatus(PREVIEW_MESSAGE);
                }}
              />
              <button className="pl-button pl-join" data-sfx="uiConfirm" type="submit" disabled={busy}>Katıl</button>
            </div>
            <p className="pl-error" id="pl-room-error" aria-live="polite">{roomCodeError}</p>
          </form>

          <p className="pl-status" role="status" aria-atomic="true">{busy ? "Lobiye bağlanılıyor…" : network.snapshot.notice || status}</p>
          <button className="pl-local-test" type="button" disabled={busy} onClick={() => setInArena(true)}>
            Yerel Test Arenası <span aria-hidden="true">↗</span>
          </button>
          <button ref={controlsEntry} className="pl-local-test" type="button" onClick={() => setControlsOpen(true)}>Kontroller</button>
        </section>
      </main>

      <footer className="pl-footer"><span>Küçük bir deney. Büyük bir eğlence fikri.</span><span>En fazla 3 oyuncu</span></footer>
    </div>
  );
}
