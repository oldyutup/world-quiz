import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { WinnerChoice } from "../../../../shared/party-lab/board/rules";
import { usePartyAudio } from "../../audio/PartyAudio";
import type { Bindings } from "../../input/bindings";
import type { LobbySnapshot } from "../../network/types";
import { ArenaMenu, ArenaStatus, MenuButton, useArenaMenu } from "../ArenaChrome";
import BoardHud, { DICE_REVEAL_MS } from "./BoardHud";
import BoardScene, { type RollClock } from "./BoardScene";
import { BOARD_FOV } from "./boardCamera";
import "./board.css";

interface Props {
  lobby: LobbySnapshot;
  onChoose: (choice: WinnerChoice) => void;
  onRoll: () => void;
  bindings: Bindings;
  onBindings: (bindings: Bindings) => void;
  bindingsSaved: boolean;
  /** Controls opened from outside: no keys, no presentation work. */
  paused: boolean;
  onLeave: () => void;
}

/**
 * Tahta Oyunu between mini games: the board, the turns and the celebration. The server
 * owns every square and every die; this page animates what it is told and sends only
 * "two dice" / "+1" and "roll" for its own turn.
 */
export default function OnlineBoardArena({ lobby, onChoose, onRoll, bindings, onBindings, bindingsSaved, paused, onLeave }: Props) {
  const board = lobby.board!;
  const { audio } = usePartyAudio();
  const menu = useArenaMenu(!paused);
  const off = paused || menu.view !== null || lobby.status !== "connected";
  const self = lobby.players.find((p) => p.id === lobby.selfId);
  const selfSlot = self && board.pieces.some(([slot]) => slot === self.slot) ? self.slot : -1;
  // A roll seen arriving is animated from now; one already over when the page opened is not replayed.
  const clock = useRef<RollClock>({ seq: board.roll?.seq ?? 0, at: board.phase === "move" ? performance.now() : -Infinity });
  if (board.roll && board.roll.seq !== clock.current.seq) clock.current = { seq: board.roll.seq, at: performance.now() };
  // Special square effects: the same rule.
  const effectClock = useRef<RollClock>({ seq: board.effect?.seq ?? 0, at: board.phase === "effect" ? performance.now() : -Infinity });
  if (board.effect && board.effect.seq !== effectClock.current.seq) effectClock.current = { seq: board.effect.seq, at: performance.now() };
  const [, redraw] = useState(0);
  // Coming back from a mini game the canvas needs a moment: a cover, not an empty frame.
  const [drawn, setDrawn] = useState(false);
  const sinceRoll = performance.now() - clock.current.at;
  const diceShown = !board.roll || sinceRoll >= DICE_REVEAL_MS;
  // The HUD reveals the dice when they land: one redraw at that moment.
  useEffect(() => {
    if (diceShown) return;
    const timer = setTimeout(() => redraw((n) => n + 1), DICE_REVEAL_MS - sinceRoll + 20);
    return () => clearTimeout(timer);
  }, [diceShown, board.roll?.seq]);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!off) viewport.current?.focus();
  }, [off]);
  // Keys for my own turn: Space/Enter roll, 1/2 choose.
  const turn = useRef({ board, selfSlot, off });
  turn.current = { board, selfSlot, off };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { board, selfSlot, off } = turn.current;
      if (off || event.repeat || board.current !== selfSlot || selfSlot < 0) return;
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (board.phase === "roll" && (event.code === "Space" || event.code === "Enter")) {
        event.preventDefault();
        onRoll();
      } else if (board.phase === "choose" && (event.code === "Digit1" || event.code === "Numpad1")) onChoose("two");
      else if (board.phase === "choose" && (event.code === "Digit2" || event.code === "Numpad2")) onChoose("plus");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onRoll, onChoose]);

  return (
    <div className="party-lab pl-playground pl-immersive" data-mode="board_game">
      <div ref={viewport} className="pl-viewport" tabIndex={0} role="region" aria-label="Online Tahta Oyunu" onPointerDown={() => viewport.current?.focus()}>
        <Canvas dpr={[1, 1.5]} camera={{ position: [0, 24, 20], fov: BOARD_FOV, near: 0.1, far: 400 }} gl={{ antialias: true }}>
          <Suspense fallback={null}>
            <BoardScene board={board} players={lobby.players} clock={clock} effectClock={effectClock} audio={paused ? undefined : audio} onReady={() => setDrawn(true)} />
          </Suspense>
        </Canvas>
        {!drawn && <div className="pl-board-cover" aria-hidden="true"><span>Tahta hazırlanıyor…</span></div>}
        <MenuButton onOpen={() => menu.setView("main")} />
        <BoardHud board={board} players={lobby.players} selfSlot={selfSlot} diceShown={diceShown} connected={lobby.status === "connected" && !off} onChoose={onChoose} onRoll={onRoll} />
        <div className="pl-arena-side">
          <ArenaStatus lobby={lobby} spectating={selfSlot < 0} />
        </div>
      </div>
      {menu.view && (
        <ArenaMenu
          view={menu.view}
          setView={menu.setView}
          onResume={() => menu.setView(null)}
          onLeave={onLeave}
          lobby={lobby}
          modeName="Tahta Oyunu"
          bindings={bindings}
          onBindings={onBindings}
          bindingsSaved={bindingsSaved}
          menuNote="Tahta arkada sürüyor. Odadan ayrılırsan tahtadan çıkarsın; bağlantın koparsa yerin 2 dakika korunur."
          controlsContent={
            <div className="pl-board-menu-controls" data-party-controls>
              <header className="pl-menu-panel-head">
                <button className="pl-button pl-join" data-sfx="uiBack" onClick={() => menu.setView("main")}>
                  ← Menüye Dön
                </button>
              </header>
              <p>
                <kbd>Space</kbd> veya <kbd>Enter</kbd> zar at · <kbd>1</kbd> İki zar · <kbd>2</kbd> +1
                <br />
                Butonlara tıklayarak da oynayabilirsin. Mini oyunlarda her modun kendi kontrolleri geçerli.
                <br />
                Renkli kareler yalnız tam üstlerine düşünce çalışır; anlamları tahtanın köşesinde.
              </p>
            </div>
          }
        />
      )}
    </div>
  );
}
