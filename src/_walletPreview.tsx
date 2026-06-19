// TEMPORARY, UNTRACKED preview harness for the "Gezgin Kimliği" wallet panel.
// Mounts the real <UserProfileDropdown> with the real App.css and a mock
// profile so it can be screenshotted headless without standing up auth.
// Now also renders the real home-screen background + a small real mode-grid so
// a single shot shows: theme background + open profile panel + "Oyna" buttons.
// Drive the theme with ?theme=default|turkiye|adventure|dark-space.
// Safe to delete; not referenced by the app.
import React from "react";
import { createRoot } from "react-dom/client";
import "./App.css";
import { UserProfileDropdown } from "./components/UserProfileDropdown";
import { getThemeBackgroundStyle, type HomeTheme } from "./lib/themeBackgrounds";

// Keep the preview deterministic: block the real XP network call so the panel
// keeps using the mock profile.xp (an unknown user otherwise resolves to 0 XP
// and the level flickers between renders).
window.fetch = (() => new Promise<never>(() => {})) as any;

const params = new URLSearchParams(location.search);
const open = params.get("open") !== "0";
const canBonus = params.get("bonus") !== "0";
const theme = (params.get("theme") as HomeTheme) || "default";

const profile: any = {
  id: "preview-user",
  username: "gezginpasa",
  avatar_id: null,
  xp: 1840,
};

document.documentElement.style.background = "#0d1117";
document.body.style.margin = "0";

const homeClass =
  "home-screen" +
  (theme === "turkiye"
    ? " home-screen--turkiye"
    : theme === "adventure"
    ? " home-screen--adventure"
    : theme === "dark-space"
    ? " home-screen--dark-space"
    : "");

const demoModes = [
  { icon: "🌍", title: "ÜLKE YAZ", desc: "Tek oyuncu veya online oyna.", available: true },
  { icon: "🚩", title: "BAYRAK MODU", desc: "Bayrakları tanı, ülke adını yaz.", available: true },
  { icon: "🎯", title: "ÇARK MODU", desc: "Çarkın seçtiği ülkeyi haritada bul.", available: true },
  { icon: "🕵️", title: "KÖR NOKTA", desc: "Raporlara güven, konumu bul.", available: false },
];

function Demo() {
  const [soundEnabled, setSoundEnabled] = React.useState(true);
  const [mode, setMode] = React.useState<any>("last10");
  return (
    <div
      className={homeClass}
      style={theme !== "default" ? getThemeBackgroundStyle(theme) : undefined}
    >
      <div className="home-hero">
        <p className="home-subtitle" style={{ marginTop: 64 }}>Dünya bilginizi test edin.</p>
      </div>
      <div className="mode-grid">
        {demoModes.map((m, i) => (
          <div key={i} className={"mode-card" + (m.available ? "" : " mode-card--soon")}>
            {!m.available && <span className="soon-badge">Yakında</span>}
            <div className="mode-card-icon" style={{ fontSize: 30 }}>{m.icon}</div>
            <div className="mode-card-content">
              <h2 className="mode-card-title">{m.title}</h2>
              <p className="mode-card-desc">{m.desc}</p>
            </div>
            <button
              className={"btn btn-accent mode-card-btn" + (m.available ? "" : " disabled")}
              disabled={!m.available}
            >
              {m.available ? "Oyna" : "Yakında"}
            </button>
          </div>
        ))}
      </div>

      <div className="top-right-stack">
        <div className="social-bar">
          <UserProfileDropdown
            homeTheme={theme}
            profile={profile}
            authLoading={false}
            gold={1280}
            canBonus={canBonus}
            soundEnabled={soundEnabled}
            countdownSoundMode={mode}
            onClaimBonus={() => {}}
            onSetSoundEnabled={setSoundEnabled}
            onSetCountdownSoundMode={setMode}
            onLogout={() => {}}
            onLogin={() => {}}
            controlledOpen={open}
            onRequestEditProfile={() => {}}
          />
        </div>
        <button type="button" className="lb-trigger">🏆&nbsp;Sıralama</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
