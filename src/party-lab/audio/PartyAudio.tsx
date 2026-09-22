import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AudioManager } from "./AudioManager";
import {
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettings,
} from "./settings";
import type { SfxName } from "./events";
interface AudioSession {
  audio: AudioManager;
  settings: AudioSettings;
  saved: boolean;
  update: (settings: AudioSettings) => void;
}
const Context = createContext<AudioSession | null>(null);
export function usePartyAudio() {
  const session = useContext(Context);
  if (!session) throw Error("Party Lab audio provider missing");
  return session;
}
export function PartyAudio({ children }: { children: ReactNode }) {
  const [audio] = useState(() => new AudioManager());
  const [settings, setSettings] = useState(loadAudioSettings);
  const [saved, setSaved] = useState(true);
  const update = useCallback(
    (next: AudioSettings) => {
      audio.setSettings(next);
      setSettings(next);
      setSaved(saveAudioSettings(next));
    },
    [audio]
  );
  useEffect(() => {
    audio.setSettings(settings);
  }, [audio, settings]);
  useEffect(() => {
    const visibility = () => audio.setBackground(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      audio.dispose();
    };
  }, [audio]);
  return (
    <Context.Provider value={{ audio, settings, saved, update }}>
      <div
        className="pl-audio-scope"
        onPointerDownCapture={(event) => {
          if (event.isTrusted) void audio.unlock();
        }}
        onKeyDownCapture={(event) => {
          if (event.isTrusted) void audio.unlock();
        }}
        onClickCapture={(event) => {
          const button = (
            event.target as HTMLElement
          ).closest<HTMLButtonElement>("button");
          if (button && !button.disabled && button.dataset.sfx !== "none")
            void audio.playUi(
              (button.dataset.sfx as SfxName | undefined) ?? "uiClick"
            );
        }}
      >
        {children}
      </div>
    </Context.Provider>
  );
}
