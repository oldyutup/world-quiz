import { useEffect, useState } from "react";
import { usePartyAudio } from "./PartyAudio";
import type { SfxName } from "./events";
export const PREVIEWS: [SfxName, string][] = [
  ["punchSwing", "Yumruk savuruşu"],
  ["bodyHit", "Gövde teması"],
  ["headHit", "Baş teması"],
  ["limbHit", "Kol / bacak teması"],
  ["lightBump", "Hafif çarpışma"],
  ["heavyBump", "Güçlü çarpışma"],
  ["floorFlop", "Yere düşüş"],
  ["grab", "Tek el tutuş"],
  ["secondGrab", "İkinci el"],
  ["gripBreak", "Tutuştan kaçış"],
  ["lift", "Kaldırma"],
  ["release", "Bırakma"],
  ["throw", "Savurma"],
  ["fall", "Arenadan düşüş"],
  ["knockout", "Bayılma"],
  ["recovery", "Toparlanma"],
  ["jump", "Zıplama"],
  ["landing", "Yere iniş"],
  ["countdown", "Geri sayım"],
  ["roundStart", "Tur başlangıcı"],
  ["winner", "Kazanan"],
  ["draw", "Beraberlik"],
  ["uiClick", "Düğme"],
  ["uiConfirm", "Onay"],
  ["uiBack", "Geri"],
];
export default function AudioSettings({ disabled }: { disabled: boolean }) {
  const { audio, settings, saved, update } = usePartyAudio();
  const [preview, setPreview] = useState<SfxName>("bodyHit");
  const [previewNotice, setPreviewNotice] = useState("");
  useEffect(() => setPreviewNotice(""), [settings, preview]);
  return (
    <fieldset className="pl-audio-settings" disabled={disabled}>
      <legend>Ses ve oyun hissi</legend>
      <p>Yumuşak vuruşlar, lastik gibi sesler. Kulaklarına göre ayarla.</p>
      {(
        [
          ["master", "Master Ses"],
          ["sfx", "Efekt Sesleri"],
        ] as const
      ).map(([key, label]) => (
        <label className="pl-volume-row" key={key} htmlFor={`pl-audio-${key}`}>
          <span>{label}</span>
          <input
            id={`pl-audio-${key}`}
            type="range"
            min="0"
            max="100"
            step="1"
            value={settings[key]}
            onChange={(event) =>
              update({ ...settings, [key]: Number(event.target.value) })
            }
          />
          <output>{settings[key]}%</output>
        </label>
      ))}
      <div className="pl-audio-options">
        <label>
          <input
            type="checkbox"
            checked={settings.muted}
            onChange={(event) =>
              update({ ...settings, muted: event.target.checked })
            }
          />{" "}
          Sessiz
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.cameraShake}
            onChange={(event) =>
              update({ ...settings, cameraShake: event.target.checked })
            }
          />{" "}
          Kamera Sarsıntısı
        </label>
      </div>
      <div className="pl-audio-preview">
        <select
          aria-label="Deneme sesi"
          value={preview}
          onChange={(event) => setPreview(event.target.value as SfxName)}
        >
          {PREVIEWS.map(([name, label]) => (
            <option key={name} value={name}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="pl-button pl-join"
          data-sfx="none"
          onClick={async () => {
            const played = await audio.playUi(preview);
            setPreviewNotice(
              played
                ? `${
                    PREVIEWS.find(([name]) => name === preview)?.[1]
                  } önizlemesi oynatıldı.`
                : settings.muted || !settings.master || !settings.sfx
                ? "Ses kapalı. Denemek için sesi aç."
                : "Ses açılamadı. Tekrar deneyebilirsin."
            );
          }}
        >
          Sesi Dene
        </button>
      </div>
      <p role="status" className="pl-settings-note">
        {previewNotice}
      </p>
      <p className="pl-settings-note">
        Hareketi azalt tercihin açıksa kamera sarsılmaz. Ayarlar yalnız bu
        tarayıcıya kaydedilir.
      </p>
      {!saved && (
        <p role="alert">
          Ses ayarları kaydedilemedi. Bu oturumda geçerli kalacak.
        </p>
      )}
    </fieldset>
  );
}
