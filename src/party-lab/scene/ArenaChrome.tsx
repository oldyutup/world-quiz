import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import ControlsSettings from "../ControlsSettings";
import AudioSettings from "../audio/AudioSettings";
import type { Bindings } from "../input/bindings";
import type { LookMode } from "../input/look";
import type { LobbySnapshot } from "../network/types";
import { EscapeGate, HINT_MS, escapeStep, type MenuView } from "./arenaMenu";

/*
 * Immersive arena chrome, shared by online Rooftop Brawl and Barn Shootout and the local
 * Katman Kaosu: the arena fills the page, gameplay HUD sits on it, and everything else
 * lives in the Esc menu. The menu never pauses the match (see arenaMenu.ts).
 */

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void };
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsDocument = () => document as FullscreenDocument;
export const fullscreenElement = () => fsDocument().fullscreenElement ?? fsDocument().webkitFullscreenElement ?? null;
const fullscreenSupported = () => !!(fsDocument().fullscreenEnabled ?? fsDocument().webkitFullscreenEnabled);
/** Optional browser fullscreen (the layout never depends on it). Needs a user gesture. */
async function toggleFullscreen() {
  const d = fsDocument(),
    root = document.documentElement as FullscreenRoot;
  try {
    if (fullscreenElement()) await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
    else await (root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen?.());
  } catch {
    // Refused (no gesture, iframe policy, iOS): the in-page layout stays as it is.
  }
}

/**
 * Esc and lock-loss handling. `enabled` is false while the arena is hidden (Controls
 * opened from the lobby). `lockEnded` is called when the browser ends Pointer Lock on
 * its own (Esc, focus loss); fullscreen ending the same way is handled here.
 */
export function useArenaMenu(enabled: boolean) {
  const [view, setView] = useState<MenuView | null>(null);
  const gate = useRef(new EscapeGate());
  const live = useRef(enabled);
  live.current = enabled;
  const lockEnded = useCallback(() => {
    gate.current.lockEnded(performance.now());
    if (live.current) setView((current) => current ?? "main");
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // Bubble phase: the key capture in Controls (window, capture phase) swallows its own Esc.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.isComposing) return;
      if (!gate.current.accepts(performance.now(), !!document.pointerLockElement)) return;
      event.preventDefault();
      setView(escapeStep);
    };
    const fullscreenChange = () => {
      if (!fullscreenElement()) lockEnded();
    };
    window.addEventListener("keydown", key);
    document.addEventListener("fullscreenchange", fullscreenChange);
    document.addEventListener("webkitfullscreenchange", fullscreenChange);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("fullscreenchange", fullscreenChange);
      document.removeEventListener("webkitfullscreenchange", fullscreenChange);
    };
  }, [enabled, lockEnded]);
  // Leaving the menu after visiting Controls shows the (possibly rebound) controls line again.
  const [hintReplay, setHintReplay] = useState(0);
  const sawControls = useRef(false);
  useEffect(() => {
    if (view === "controls") sawControls.current = true;
    else if (view === null && sawControls.current) {
      sawControls.current = false;
      setHintReplay((n) => n + 1);
    }
  }, [view]);
  return { view: enabled ? view : null, setView, lockEnded, hintReplay };
}

/** The controls line: shown when the arena opens, fades HINT_MS into play; `replay` shows it again. */
export function ControlHint({ text, playing, replay, hidden }: { text: string; playing: boolean; replay: number; hidden: boolean }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (replay) setShown(true);
  }, [replay]);
  useEffect(() => {
    if (!playing || !shown) return;
    const timer = setTimeout(() => setShown(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [playing, shown, replay]);
  return (
    <div className="pl-control-hint" data-shown={shown && !hidden ? "true" : "false"} aria-hidden={!shown || hidden}>
      {text}
    </div>
  );
}

/** Connection and spectator state. Silent (screen readers only) while all is well. */
export function ArenaStatus({ lobby, spectating }: { lobby: LobbySnapshot; spectating: boolean }) {
  const text =
    lobby.status === "connected"
      ? lobby.link === "degraded"
        ? "Bağlantı yavaş: sunucudan veri gecikiyor. Bağlantı kesilmedi."
        : "Sunucuya bağlı"
      : lobby.status === "reconnecting"
      ? "Bağlantı kesildi. Yeniden bağlanılıyor…"
      : "Bağlantı kapandı.";
  const normal = lobby.status === "connected" && lobby.link !== "degraded";
  return (
    <>
      <p className={`pl-online-status pl-arena-chip${normal ? " pl-visually-hidden" : ""}${lobby.status === "connected" && lobby.link === "degraded" ? " is-degraded" : ""}`} role="status">
        {text}
      </p>
      {spectating && <p className="pl-arena-chip">İzliyorsun. Sonraki tur lobide hazır olabilirsin.</p>}
    </>
  );
}

/**
 * Available with `debug` (online: `?partyDebug=1`; the local arena always): collapsed
 * during play unless `openAtStart`, opened from the menu, kept for this page session.
 */
let debugPanelOpen: boolean | null = null;
export function useDebugPanel(debug: boolean, openAtStart = false) {
  const [open, setOpen] = useState(() => debug && (debugPanelOpen ?? openAtStart));
  const toggle = useCallback(() => {
    setOpen((value) => (debugPanelOpen = !value));
  }, []);
  return { open: debug && open, toggle };
}

interface MenuProps {
  view: MenuView;
  setView: (view: MenuView | null) => void;
  /** Close and return to play (the arena decides what the next click does). */
  onResume: () => void;
  onLeave: () => void;
  /** "Odadan Ayrıl" online; the local arena says where it goes. */
  leaveLabel?: string;
  /** The online room (code, invite link); null in the local arena. */
  lobby: LobbySnapshot | null;
  modeName: string;
  bindings: Bindings;
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  look?: { mode: LookMode; onChange: (mode: LookMode) => void };
  debug?: { open: boolean; onToggle: () => void } | null;
  /** Extra setting rows under the look mode (the local arena's map and player count). */
  children?: ReactNode;
}

/** Esc menu over the arena. The match (online or local) keeps running behind it. */
export function ArenaMenu({ view, setView, onResume, onLeave, leaveLabel = "Odadan Ayrıl", lobby, modeName, bindings, onBindings, bindingsSaved, look, debug, children }: MenuProps) {
  const resume = useRef<HTMLButtonElement>(null);
  const openers = { controls: useRef<HTMLButtonElement>(null), audio: useRef<HTMLButtonElement>(null) };
  const cameFrom = useRef<MenuView>("main");
  const [copy, setCopy] = useState("");
  const [fullscreen, setFullscreen] = useState(() => !!fullscreenElement());
  useEffect(() => {
    const update = () => setFullscreen(!!fullscreenElement());
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);
  // Focus follows the view: back on the button that opened a sub-view, else "Oyuna Dön".
  useLayoutEffect(() => {
    if (view !== "main") {
      cameFrom.current = view;
      return;
    }
    const from = cameFrom.current;
    (from === "main" ? resume : openers[from]).current?.focus();
    cameFrom.current = "main";
  }, [view]);
  async function copyInvite() {
    if (!lobby) return;
    const invite = new URL("/party-lab", window.location.origin);
    invite.searchParams.set("room", lobby.code);
    try {
      await navigator.clipboard.writeText(invite.href);
      setCopy("Davet bağlantısı kopyalandı.");
    } catch {
      setCopy(`Kopyalanamadı. Oda kodu: ${lobby.code}`);
    }
  }
  let body: ReactNode;
  if (view === "controls")
    body = (
      <div className="pl-menu-panel">
        <ControlsSettings embedded bindings={bindings} onChange={onBindings} saved={bindingsSaved} inArena online={!!lobby} onClose={() => setView("main")} />
      </div>
    );
  else if (view === "audio")
    body = (
      <div className="pl-menu-panel pl-menu-audio" data-party-controls>
        <header className="pl-menu-panel-head">
          <button className="pl-button pl-join" data-sfx="uiBack" onClick={() => setView("main")}>
            ← Menüye Dön
          </button>
        </header>
        <AudioSettings disabled={false} />
      </div>
    );
  else
    body = (
      <div className="pl-menu" data-party-controls>
        <span className="pl-eyebrow">
          {modeName} · {lobby ? `Oda ${lobby.code}` : "Yerel"}
        </span>
        <h2 id="pl-menu-title">Menü</h2>
        <p className="pl-menu-note">Maç arkada sürüyor; bu bir duraklatma değil.</p>
        <button ref={resume} className="pl-button pl-create pl-menu-primary" data-sfx="uiConfirm" onClick={onResume}>
          Oyuna Dön
        </button>
        <button ref={openers.controls} className="pl-button pl-join" onClick={() => setView("controls")}>
          Kontroller
        </button>
        <button ref={openers.audio} className="pl-button pl-join" onClick={() => setView("audio")}>
          Ses
        </button>
        {look && (
          <label className="pl-menu-row">
            <span>Bakış</span>
            <select value={look.mode} onChange={(event) => look.onChange(event.target.value as LookMode)}>
              <option value="lock">İmleç kilidi</option>
              <option value="drag">Sürükleyerek bak</option>
            </select>
          </label>
        )}
        {children}
        {fullscreenSupported() && (
          <button className="pl-button pl-join" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>
            {fullscreen ? "Tam Ekrandan Çık" : "Tam Ekran"}
          </button>
        )}
        {debug && (
          <button className="pl-button pl-join" aria-pressed={debug.open} onClick={debug.onToggle}>
            Debug bilgileri: {debug.open ? "Açık" : "Kapalı"}
          </button>
        )}
        {lobby && (
          <>
            <div className="pl-menu-room">
              <span>
                Oda kodu <b>{lobby.code}</b>
              </span>
              <button className="pl-invite-link" onClick={() => void copyInvite()}>
                Daveti kopyala
              </button>
            </div>
            <p className="pl-menu-copy" role="status">
              {copy}
            </p>
          </>
        )}
        <button className="pl-button pl-quiet pl-menu-leave" data-sfx="uiBack" onClick={onLeave}>
          {leaveLabel}
        </button>
      </div>
    );
  return (
    <div className="pl-menu-overlay" role="dialog" aria-modal="true" aria-labelledby={view === "main" ? "pl-menu-title" : undefined} aria-label={view === "main" ? undefined : "Oyun menüsü"}>
      {body}
    </div>
  );
}

/** The small always-available way into the menu for mouse/trackpad players. */
export function MenuButton({ onOpen, buttonRef }: { onOpen: () => void; buttonRef?: RefObject<HTMLButtonElement> }) {
  return (
    <button ref={buttonRef} type="button" className="pl-menu-button" aria-label="Menüyü aç (Esc)" onClick={onOpen}>
      <span aria-hidden="true">☰</span> Menü <kbd>Esc</kbd>
    </button>
  );
}
