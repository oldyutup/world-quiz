import { useEffect, useRef, useState } from "react";
import { ACTIONS, ACTION_LABELS, type Action } from "./input/actions";
import {
  bindingLabel,
  changeBinding,
  conflicts,
  type Bindings,
} from "./input/bindings";
import { captureBinding } from "./input/capture";
import { defaultBindings } from "./input/defaults";

export default function ControlsSettings({
  bindings,
  onChange,
  onClose,
  inArena,
  saved,
}: {
  bindings: Bindings;
  onChange: (bindings: Bindings) => void;
  onClose: () => void;
  inArena: boolean;
  saved: boolean;
}) {
  const [capture, setCapture] = useState<{
    action: Action;
    slot: 0 | 1;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const slotButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  useEffect(() => {
    if (!capture) {
      slotButton.current?.focus();
      return;
    }
    return captureBinding((binding) => {
      if (binding === null) setNotice("Tuş atama iptal edildi.");
      else {
        const used = conflicts(bindings, capture.action, binding);
        const next = changeBinding(
          bindings,
          capture.action,
          capture.slot,
          binding
        );
        if (next) {
          onChange(next);
          setNotice(
            `${ACTION_LABELS[capture.action]}: ${bindingLabel(binding)} atandı.`
          );
        } else
          setNotice(
            `${bindingLabel(binding)} zaten ${used
              .map((action) => ACTION_LABELS[action])
              .join(
                ", "
              )} için kullanılıyor. Önce o atamayı değiştir veya başka bir tuş seç. Mevcut atama korundu.`
          );
      }
      setCapture(null);
    });
  }, [capture, bindings, onChange]);

  return (
    <div className="party-lab pl-settings" data-party-controls>
      <header className="pl-topbar">
        <span className="pl-brand">
          torble<span className="pl-brand-divider">/</span>party lab
        </span>
        <button
          className="pl-button pl-join"
          onClick={onClose}
          disabled={!!capture}
        >
          {inArena ? "Arenaya Dön" : "Lobiye Dön"}
        </button>
      </header>
      <main className="pl-settings-main">
        <span className="pl-eyebrow">Senin oyunun, senin tuşların</span>
        <h1 ref={title} tabIndex={-1}>
          Kontroller
        </h1>
        <p>
          Her hareketi klavyeyle yapabilirsin. Mouse veya trackpad, ikinci bir
          seçenek.
        </p>
        <p className="pl-settings-note">
          Bir atamayı seç, sonra yeni tuşa basıp bırak. ESC ile iptal et.{" "}
          {inArena && "Arena duraklatıldı."}
        </p>
        <div
          className="pl-settings-feedback"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {capture
            ? `${
                ACTION_LABELS[capture.action]
              }: Yeni tuşa veya mouse düğmesine bas. ESC ile iptal et.`
            : notice || "Atamalar bu tarayıcıda otomatik kaydedilir."}
        </div>
        <div className="pl-binding-head" aria-hidden="true">
          <span>Hareket</span>
          <span>Birincil</span>
          <span>İkincil · isteğe bağlı</span>
        </div>
        <div className="pl-binding-list">
          {ACTIONS.map((action) => (
            <div className="pl-binding-row" key={action}>
              <span className="pl-action-label">{ACTION_LABELS[action]}</span>
              {([0, 1] as const).map((slot) => (
                <div className="pl-binding-slot" key={slot}>
                  <button
                    className="pl-binding-button"
                    disabled={!!capture}
                    aria-label={`${ACTION_LABELS[action]} ${
                      slot === 0 ? "birincil" : "ikincil"
                    }: ${
                      bindings[action][slot]
                        ? bindingLabel(bindings[action][slot]!)
                        : "Ata"
                    }`}
                    onClick={(event) => {
                      slotButton.current = event.currentTarget;
                      setNotice("");
                      setCapture({ action, slot });
                    }}
                  >
                    {capture?.action === action && capture.slot === slot
                      ? "Bekleniyor…"
                      : bindings[action][slot]
                      ? bindingLabel(bindings[action][slot]!)
                      : "+ Ata"}
                  </button>
                  {slot === 1 && bindings[action][slot] && (
                    <button
                      className="pl-binding-remove"
                      disabled={!!capture}
                      aria-label={`${ACTION_LABELS[action]} ikincil atamasını kaldır`}
                      onClick={() => {
                        const next = changeBinding(bindings, action, 1, null);
                        if (next) {
                          onChange(next);
                          setNotice("İkincil atama kaldırıldı.");
                        }
                      }}
                    >
                      Kaldır
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        {!saved && (
          <p role="alert" className="pl-error">
            Tarayıcı kaydetmeye izin vermedi. Kontroller bu oturumda geçerli;
            sayfa yenilenince sıfırlanabilir.
          </p>
        )}
        <div className="pl-settings-bottom">
          <button
            className="pl-button pl-join"
            disabled={!!capture}
            onClick={() => {
              onChange(defaultBindings());
              setNotice("Varsayılan kontroller geri yüklendi.");
            }}
          >
            Varsayılana Dön
          </button>
          <p>
            Tutmayı basılı tut; kaldırıp hareket et, savurmak için bırak.
            Yumruklar sırayla sol ve sağ elle gelir.
          </p>
        </div>
        <p className="pl-settings-note">
          Tuşlar fiziksel konumlarına göre atanır. CTRL / ALT tek başına
          kullanılabilir; tarayıcı ve sistem kısayolları ayrılmıştır.
        </p>
      </main>
    </div>
  );
}
