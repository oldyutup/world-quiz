import type { CSSProperties } from "react";
import { BOARD, BOARD_LENGTH_NAMES, isBoardLength } from "../../../../shared/party-lab/board/config";
import type { WinnerChoice } from "../../../../shared/party-lab/board/rules";
import type { BoardWire } from "../../../../shared/party-lab/board/wire";
import { MODE_NAMES } from "../../../../shared/party-lab/modes";
import type { LobbyPlayer } from "../../network/types";
import { COSTUME_SYMBOLS } from "../visual/costumes";
import { squaresLeft } from "./boardMotion";
import { boardBanner, CHOICE_LABELS } from "./boardText";
import { GLYPH_STROKE, LEGEND_ORDER, SQUARE_STYLE } from "./squareStyle";

/** The special squares, in a corner of the board: colour, glyph, name, rule. */
export function BoardLegend() {
  return (
    <aside className="pl-board-card pl-board-legend" aria-label="Özel kareler">
      <ul>
        {LEGEND_ORDER.map((type) => {
          const style = SQUARE_STYLE[type];
          return (
            <li key={type} data-square={type} title={`${style.name}: ${style.rule}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true" style={{ background: style.color }}>
                <path d={style.glyph} fill="none" stroke="#fffaf0" strokeWidth={GLYPH_STROKE} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>
                <b>{style.name}</b>
                <small>{style.rule}</small>
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

export default function BoardHud({ board, players, selfSlot, diceShown, connected, onChoose, onRoll }: {
  board: BoardWire;
  players: LobbyPlayer[];
  selfSlot: number;
  diceShown: boolean;
  connected: boolean;
  onChoose: (choice: WinnerChoice) => void;
  onRoll: () => void;
}) {
  const player = (slot: number) => players.find((p) => p.slot === slot);
  const name = (slot: number) => player(slot)?.nickname ?? "Ayrılan oyuncu";
  const banner = boardBanner(board, name, selfSlot, diceShown);
  const mine = board.current === selfSlot && selfSlot >= 0 && connected;
  const standings = [...board.pieces].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const length = isBoardLength(board.length) ? `${BOARD_LENGTH_NAMES[board.length]} · ${board.length} kare` : `${board.length} kare`;
  const timed = board.phase === "choose" || board.phase === "roll" || board.phase === "intro";
  return (
    <div className="pl-board-hud">
      <header className="pl-board-card pl-board-heading">
        <span>TAHTA OYUNU</span>
        <strong>Tur {board.round}</strong>
        <span>{length}</span>
        {board.lastMode && (
          <p>
            Son mini oyun: <b>{MODE_NAMES[board.lastMode]}</b>
            <br />
            {board.first >= 0 ? (
              <>Birinci: <b style={{ color: player(board.first)?.color }}>{name(board.first)}</b></>
            ) : (
              "Birinci yok · herkes tek zar"
            )}
          </p>
        )}
      </header>
      <ol className="pl-board-card pl-board-players" aria-label="Hazineye kalan kareler">
        {standings.map(([slot]) => {
          const p = player(slot),
            left = squaresLeft(board, slot);
          return (
            <li key={slot} data-current={board.current === slot} data-self={slot === selfSlot} data-away={!p?.connected} style={{ "--board-player": p?.color ?? "#ccc" } as CSSProperties}>
              <i aria-hidden="true">{p ? COSTUME_SYMBOLS[p.costumeId] : "?"}</i>
              <span>
                {name(slot)}
                {slot === selfSlot && <em>Sen</em>}
                {board.bonus.includes(slot) && (
                  <em className="pl-board-bonus" title="Bonus zar: sonraki zara +1">
                    🎲+1
                  </em>
                )}
                <small>{!p?.connected ? "Bağlantı bekleniyor · sırası otomatik" : board.first === slot ? "Son mini oyunun birincisi" : board.current === slot ? "Sırada" : " "}</small>
              </span>
              <b>
                {left}
                <small>{left === 0 ? "hazine!" : "kare kaldı"}</small>
              </b>
            </li>
          );
        })}
      </ol>
      {board.phase !== "finished" && <BoardLegend />}
      {board.phase !== "finished" && (
        <div className="pl-board-banner" role="status" data-phase={board.phase} data-square={board.phase === "effect" ? board.effect?.type : undefined}>
          <strong>{banner.title}</strong>
          <span>
            {banner.detail}
            {timed && board.left > 0 && <b className="pl-board-timer"> · {board.left}</b>}
          </span>
        </div>
      )}
      {mine && board.phase === "choose" && (
        <div className="pl-board-actions" role="group" aria-label="Zar seçimi">
          <button type="button" className="pl-board-choice" data-sfx="uiConfirm" onClick={() => onChoose("two")}>
            <strong>{CHOICE_LABELS.two}</strong>
            <small>İkisi birden atılır, büyüğü alınır</small>
            <kbd>1</kbd>
          </button>
          <button type="button" className="pl-board-choice" data-sfx="uiConfirm" onClick={() => onChoose("plus")}>
            <strong>{CHOICE_LABELS.plus}</strong>
            <small>Tek zar, sonucuna 1 eklenir</small>
            <kbd>2</kbd>
          </button>
          <p>{board.left} sn içinde seçmezsen İki zar seçilir.</p>
        </div>
      )}
      {mine && board.phase === "roll" && (
        <div className="pl-board-actions" role="group" aria-label="Zar at">
          <button type="button" className="pl-board-roll" data-sfx="uiConfirm" onClick={onRoll}>
            <strong>🎲 Zar At</strong>
            <small>
              {board.choice ? CHOICE_LABELS[board.choice] : "Tek zar"}
              {board.bonus.includes(selfSlot) && " · +1 bonus"}
            </small>
            <kbd>Space</kbd>
          </button>
          <p>{board.left} sn içinde atmazsan zar otomatik atılır.</p>
        </div>
      )}
      {board.phase === "finished" && (
        <div className="pl-board-finish" role="status">
          <span aria-hidden="true">🏆</span>
          <strong style={{ color: player(board.winner)?.color }}>{banner.title}</strong>
          <p>{banner.detail}</p>
          <ol>
            {standings.map(([slot, square], index) => (
              <li key={slot}>
                {index + 1}. {name(slot)} <small>{square >= board.length ? "hazine" : `${board.length - square} kare kaldı`}</small>
              </li>
            ))}
          </ol>
          <small>Lobiye dönülüyor… {board.left}</small>
        </div>
      )}
    </div>
  );
}

/** Time the HUD keeps the dice result hidden, so it never spoils the animation. */
export const DICE_REVEAL_MS = BOARD.diceSeconds * 1000;
