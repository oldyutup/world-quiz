/**
 * RoomCodeJoin.tsx — ana sayfa "Oda Kodu ile Katıl" yüzeyleri.
 *
 * Üç parça:
 *   • RoomCodeBar         — masaüstü üst bar içindeki kompakt input + katıl oku.
 *   • RoomCodeSheet       — mobil/dar ekran bottom-sheet (aynı akış, dokunmatik).
 *   • RoomCodeResultModal — birden fazla moda ait kod için seçim + (login sonrası)
 *                           hata bildirimi. Tek üst-seviye modal.
 *
 * Hepsi App'ten gelen tek `onSubmit(rawCode)` sözleşmesini kullanır; asıl
 * çözümleme (resolve_torble_room_code) + yönlendirme + login-gate App.tsx'te.
 * Bu bileşen bir güvenlik/katılma otoritesi DEĞİLDİR: yalnız giriş + durum UI'ı.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playSound } from "../lib/sound";
import {
  normalizeRoomCode,
  isProbablyValidRoomCode,
  type RoomCodeModeKey,
  type RoomCodeMatch,
} from "../lib/roomCode";

/** App.onSubmit sonucu. "done" = App devraldı (yönlendirdi / login açtı /
 *  ambiguous modalı açtı) → yüzey temizlenip kapanır. "error" = input yanında
 *  gösterilecek kullanıcı-dostu mesaj. */
export type RoomCodeSubmitOutcome =
  | { kind: "done" }
  | { kind: "error"; message: string };

/* ════════════════════════════════════════════════════════════════════════
   DESKTOP — üst bar kompakt kontrolü
   [ ODA KODU        → ]
════════════════════════════════════════════════════════════════════════ */
export function RoomCodeBar({
  onSubmit,
}: {
  onSubmit: (rawCode: string) => Promise<RoomCodeSubmitOutcome>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();

  const canSubmit = isProbablyValidRoomCode(value) && !busy;

  const submit = async () => {
    if (busy) return;                       // çift submit engeli (Enter + tık)
    if (!isProbablyValidRoomCode(value)) return;
    setBusy(true);
    setError(null);
    playSound("click");
    try {
      const out = await onSubmit(value);
      if (out.kind === "error") {
        setError(out.message);
      } else {
        setValue("");
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="rcj-bar"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={"rcj-bar-field" + (busy ? " rcj-bar-field--busy" : "")}>
        <input
          className="rcj-bar-input"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={6}
          placeholder="Oda Kodu"
          aria-label="Oda kodu"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(normalizeRoomCode(e.target.value));
            if (error) setError(null);
          }}
        />
        <button
          type="submit"
          className="rcj-bar-go"
          aria-label="Odaya katıl"
          disabled={!canSubmit}
          title="Odaya katıl"
        >
          {busy ? (
            <span className="rcj-spinner" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" className="rcj-bar-go-icon">
              <path d="M5 12h13M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>
      {error && (
        <div id={errId} className="rcj-bar-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   MOBİL — bottom sheet (aynı mh-sheet cam dili)
════════════════════════════════════════════════════════════════════════ */
export function RoomCodeSheet({
  onSubmit,
  onClose,
}: {
  onSubmit: (rawCode: string) => Promise<RoomCodeSubmitOutcome>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sheet lock: arka planı dondur + Escape ile kapat (mh-sheet paritesi).
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const canSubmit = isProbablyValidRoomCode(value) && !busy;

  const submit = async () => {
    if (busy) return;
    if (!isProbablyValidRoomCode(value)) return;
    setBusy(true);
    setError(null);
    playSound("click");
    try {
      const out = await onSubmit(value);
      if (out.kind === "error") {
        setError(out.message);
      } else {
        onClose();                          // App devraldı → sheet kapanır
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div
        className="mh-sheet-backdrop"
        aria-hidden="true"
        onClick={() => {
          playSound("click");
          onClose();
        }}
      />
      <div
        ref={sheetRef}
        className="mh-sheet rcj-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rcj-sheet-title"
        tabIndex={-1}
      >
        <div className="mh-sheet-grab" aria-hidden="true" />
        <header className="mh-sheet-head">
          <span className="mh-sheet-icon" aria-hidden="true">🔑</span>
          <h3 id="rcj-sheet-title" className="mh-sheet-title">Oda Kodu ile Katıl</h3>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => {
              playSound("click");
              onClose();
            }}
          >
            ✕
          </button>
        </header>

        <form
          className="rcj-sheet-body"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="rcj-sheet-label" htmlFor="rcj-sheet-input">
            Arkadaşının paylaştığı 6 haneli kodu gir.
          </label>
          <input
            id="rcj-sheet-input"
            ref={inputRef}
            className="rcj-sheet-input"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={6}
            placeholder="ÖRN: 4K7P2X"
            aria-invalid={error ? true : undefined}
            value={value}
            disabled={busy}
            onChange={(e) => {
              setValue(normalizeRoomCode(e.target.value));
              if (error) setError(null);
            }}
          />
          {error && (
            <div className="rcj-sheet-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="rcj-sheet-submit" disabled={!canSubmit}>
            {busy ? "Aranıyor…" : "Katıl"}
          </button>
        </form>
      </div>
    </>,
    document.body
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AMBIGUOUS SEÇİM / (login sonrası) HATA — tek üst-seviye modal
════════════════════════════════════════════════════════════════════════ */
export type RoomCodeResultData =
  | { kind: "ambiguous"; code: string; matches: RoomCodeMatch[] }
  | { kind: "error"; message: string };

export function RoomCodeResultModal({
  data,
  onPick,
  onClose,
}: {
  data: RoomCodeResultData;
  onPick: (mode: RoomCodeModeKey, code: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="rcj-modal-backdrop"
      onClick={() => {
        playSound("click");
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="rcj-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rcj-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="rcj-modal-close"
          aria-label="Kapat"
          onClick={() => {
            playSound("click");
            onClose();
          }}
        >
          ✕
        </button>

        {data.kind === "ambiguous" ? (
          <>
            <h3 id="rcj-modal-title" className="rcj-modal-title">
              Bu kod birden fazla aktif odada bulundu
            </h3>
            <p className="rcj-modal-sub">
              <code className="rcj-modal-code">{data.code}</code> kodunun ait
              olduğu modu seç:
            </p>
            <div className="rcj-modal-list">
              {data.matches.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  className="rcj-modal-opt"
                  onClick={() => {
                    playSound("click");
                    onPick(m.mode, data.code);
                  }}
                >
                  <span className="rcj-modal-opt-label">{m.label}</span>
                  <span className="rcj-modal-opt-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h3 id="rcj-modal-title" className="rcj-modal-title">
              Odaya katılınamadı
            </h3>
            <p className="rcj-modal-sub">{data.message}</p>
            <button
              type="button"
              className="rcj-modal-ok"
              onClick={() => {
                playSound("click");
                onClose();
              }}
            >
              Tamam
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
