/**
 * ConquestIconSelect — Kuşatma lobby/setup için PNG ikonlu ortak açılır liste.
 *
 * Native <select>/<option> açık seçeneklerde PNG ikon basamadığı için, hem
 * kapalı (seçili değer satırı) hem açık (dropdown seçenekleri) durumda her
 * seçeneğin kendi PNG'sini gösteren `.duel-select` görünümlü buton + listbox.
 *
 * DAVRANIŞ değişmez: yalnız `onChange(value)` çağırır (çağıran taraf mevcut
 * `onUpdateSettings` / `onChangeBonusDistribution` / `onChangeTeamMode`
 * mantığını korur), `disabled` (host olmayan) iken açılmaz. Harita, Görünürlük,
 * Bonus Dağıtımı ve Oyun Tipi dropdown'ları bu TEK bileşeni paylaşır; yalnız
 * seçenek listeleri/ikonları farklıdır. Yalnız Kuşatma'da kullanılır.
 *
 * Erişilebilirlik: role="listbox" + role="option", aria-selected, mouse/Enter/
 * Space ile aç-kapat, Escape + dışarı tıklama kapatır, ArrowUp/Down/Home/End ile
 * gezinme (devre dışı seçenekler atlanır), Enter ile seçim, aria-activedescendant.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ConquestAssetIcon } from "./ConquestAssetIcon";
import type { EmojiIconName } from "../../components/EmojiIcon";

export interface ConquestIconSelectOption<T extends string> {
  value: T;
  label: string;
  /** Public asset path (conquestIcons manifestinden). Yoksa emoji fallback. */
  iconSrc?: string | null;
  /** Asset yüklenemez/yoksa gösterilecek ham emoji. */
  fallbackChar?: string;
  /** Asset yüklenemez/yoksa gösterilecek tip-güvenli emoji adı (char yerine). */
  fallbackName?: EmojiIconName;
  /** Seçenek seçilemez (örn. 2v2 kapasite < 4) — dim + atlanır. */
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: ConquestIconSelectOption<T>[];
  /** Tüm kontrolü kilitler (host olmayan oyuncu). Açılmaz. */
  disabled?: boolean;
  /** role=listbox + tetikleyici erişilebilir adı (örn. "Harita seç"). */
  ariaLabel: string;
  /** Tetikleyici title (örn. devre dışı sebebi). */
  title?: string;
  /** İkon piksel boyutu — seçenek ikonları kompakt (~18), harita biraz büyük (22). */
  iconSize?: number;
  onChange: (value: T) => void;
}

const DEFAULT_ICON_PX = 18; // seçenek ikonları için kompakt boyut

export function ConquestIconSelect<T extends string>({
  value,
  options,
  disabled = false,
  ariaLabel,
  title,
  iconSize = DEFAULT_ICON_PX,
  onChange,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef    = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef    = useRef<HTMLUListElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));
  const selected = options[selectedIndex] ?? options[0];

  const firstEnabled = () => options.findIndex(o => !o.disabled);
  const lastEnabled  = () => {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return -1;
  };
  const nextEnabled = (from: number) => {
    for (let i = from + 1; i < options.length; i++) if (!options[i].disabled) return i;
    return from;
  };
  const prevEnabled = (from: number) => {
    for (let i = from - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return from;
  };

  function openList() {
    if (disabled) return;
    // Seçili (uygunsa) yoksa ilk uygun seçeneği vurgula.
    const sel = options[selectedIndex];
    setActiveIndex(sel && !sel.disabled ? selectedIndex : firstEnabled());
    setOpen(true);
  }
  function closeList(focusTrigger = true) {
    setOpen(false);
    setActiveIndex(-1);
    if (focusTrigger) triggerRef.current?.focus();
  }

  // Açıldığında klavye gezinmesi için listeye odaklan.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // Dışarı tıklama ile kapat (Escape liste/tetikleyici keydown'ında ele alınır).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const root = wrapRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
      setActiveIndex(-1);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Host değilse / devre dışıyken açık kalmasın.
  useEffect(() => {
    if (disabled && open) { setOpen(false); setActiveIndex(-1); }
  }, [disabled, open]);

  function pick(i: number) {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    closeList();
    if (opt.value !== value) onChange(opt.value);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) { if (activeIndex >= 0) pick(activeIndex); }
      else openList();
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActiveIndex(i => nextEnabled(i < 0 ? -1 : i)); break;
      case "ArrowUp":   e.preventDefault(); setActiveIndex(i => prevEnabled(i < 0 ? options.length : i)); break;
      case "Home":      e.preventDefault(); setActiveIndex(firstEnabled()); break;
      case "End":       e.preventDefault(); setActiveIndex(lastEnabled()); break;
      case "Enter":
      case " ":         e.preventDefault(); if (activeIndex >= 0) pick(activeIndex); break;
      case "Escape":    e.preventDefault(); closeList(); break;
      case "Tab":       closeList(false); break;
      default: break;
    }
  }

  return (
    <div className="duel-select-box cq-icon-select" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="duel-select cq-icon-select-trigger"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        style={{ opacity: disabled ? 0.7 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
        onClick={() => { if (disabled) return; if (open) closeList(false); else openList(); }}
        onKeyDown={onTriggerKeyDown}
      >
        <ConquestAssetIcon
          src={selected.iconSrc ?? null}
          alt=""
          className="cq-icon-select-icon"
          size={iconSize}
          fallbackChar={selected.fallbackChar}
          fallbackName={selected.fallbackName}
        />
        <span className="cq-icon-select-label">{selected.label}</span>
      </button>
      <span className="duel-select-caret" aria-hidden="true">▾</span>

      {open && !disabled && (
        <ul
          id={listId}
          ref={listRef}
          className="cq-icon-select-list"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
        >
          {options.map((o, i) => {
            const isSel    = o.value === value;
            const isActive = i === activeIndex;
            return (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled || undefined}
                className={
                  "cq-icon-select-option"
                  + (isSel    ? " cq-icon-select-option--selected" : "")
                  + (isActive ? " cq-icon-select-option--active"   : "")
                  + (o.disabled ? " cq-icon-select-option--disabled" : "")
                }
                onClick={() => pick(i)}
                onMouseEnter={() => { if (!o.disabled) setActiveIndex(i); }}
              >
                <ConquestAssetIcon
                  src={o.iconSrc ?? null}
                  alt=""
                  className="cq-icon-select-icon"
                  size={iconSize}
                  fallbackChar={o.fallbackChar}
                  fallbackName={o.fallbackName}
                />
                <span className="cq-icon-select-label">{o.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
