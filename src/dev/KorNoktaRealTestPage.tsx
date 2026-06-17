import { useEffect, useState, type CSSProperties } from "react";
import Panorama360 from "../modes/korNokta/Panorama360";
import { korNoktaRealScenes } from "../modes/korNokta/korNoktaRealScenes";
import "../modes/korNokta/KorNoktaGame.css";

// ─────────────────────────────────────────────────────────────
// DEV-ONLY Kör Nokta gerçek dünya 360 sahne testi
// (http://localhost:5173/kor-nokta-real-test). Production build'e girmez —
// main.tsx bu sayfayı yalnızca import.meta.env.DEV iken mount eder.
//
// Amaç: Panoramax pipeline'ının (scripts/korNokta/) çıktısı gerçek
// sahneleri, oyunun GERÇEK viewer'ı (Panorama360) + atıf badge'i ile tek
// tek doğrulamak. Canlı eşleşme havuzunu AÇMADAN test eder (tam oyun-döngüsü
// testi için korNoktaGameTypes.ts'te KN_INCLUDE_REAL_SCENES=true yap).
// Oyun mantığına / AI sahnelerine / native'e dokunmaz.
// ─────────────────────────────────────────────────────────────

const page: CSSProperties = {
  display: "flex", height: "100vh", width: "100vw", overflow: "hidden",
  background: "#0d1117", color: "#e6edf3",
  font: "14px/1.5 system-ui, -apple-system, sans-serif",
};
const sidebar: CSSProperties = {
  width: 300, flexShrink: 0, padding: "18px 16px", overflowY: "auto",
  borderRight: "1px solid rgba(255,255,255,0.1)", background: "#11161d",
};
const stage: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 };
const viewerWrap: CSSProperties = { position: "relative", flex: 1, minHeight: 0, background: "#000" };
const meta: CSSProperties = {
  flexShrink: 0, padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.1)",
  background: "#11161d", maxHeight: "32vh", overflowY: "auto",
};

function sceneBtn(active: boolean): CSSProperties {
  return {
    display: "block", width: "100%", textAlign: "left", marginBottom: 6,
    padding: "8px 10px", borderRadius: 8, cursor: "pointer",
    border: "1px solid " + (active ? "#4493f8" : "rgba(255,255,255,0.12)"),
    background: active ? "rgba(68,147,248,0.16)" : "rgba(255,255,255,0.03)",
    color: "#e6edf3", font: "inherit",
  };
}

type ImgInfo = { w: number; h: number; kb: number | null };

export default function KorNoktaRealTestPage() {
  const [idx, setIdx] = useState(0);
  const [imgInfo, setImgInfo] = useState<ImgInfo | null>(null);
  const scenes = korNoktaRealScenes;
  const activePath = scenes[idx]?.imagePath;

  // QC: gerçek piksel boyutu + dosya boyutu (kalite kontrolü için).
  useEffect(() => {
    if (!activePath) return;
    let alive = true;
    setImgInfo(null);
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      setImgInfo((prev) => ({ w: img.naturalWidth, h: img.naturalHeight, kb: prev?.kb ?? null }));
    };
    img.src = activePath;
    fetch(activePath).then((r) => r.blob()).then((b) => {
      if (!alive) return;
      setImgInfo((prev) => ({ w: prev?.w ?? 0, h: prev?.h ?? 0, kb: Math.round(b.size / 1024) }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [activePath]);

  if (scenes.length === 0) {
    return (
      <div style={{ ...page, alignItems: "center", justifyContent: "center" }}>
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h1>Gerçek sahne yok</h1>
          <p>Önce pipeline'ı çalıştır:</p>
          <pre style={{ background: "#161b22", padding: 12, borderRadius: 8, textAlign: "left" }}>
node scripts/korNokta/fetch-panoramax.mjs{"\n"}
node scripts/korNokta/build-real-scenes.mjs
          </pre>
        </div>
      </div>
    );
  }

  const scene = scenes[idx];

  return (
    <div style={page}>
      <aside style={sidebar}>
        <h1 style={{ fontSize: 17, margin: "0 0 4px" }}>Kör Nokta · Gerçek 360</h1>
        <p style={{ fontSize: 12, color: "#9aa7b4", margin: "0 0 14px" }}>
          DEV testi · {scenes.length} sahne · Panoramax CC-BY-SA · viewer + atıf badge doğrulaması
        </p>
        {scenes.map((s, i) => (
          <button key={s.id} style={sceneBtn(i === idx)} onClick={() => setIdx(i)}>
            <strong>{i + 1}. {s.shortTitle}</strong>
            <br />
            <span style={{ fontSize: 12, color: "#9aa7b4" }}>{s.regionLabel}</span>
          </button>
        ))}
      </aside>

      <main style={stage}>
        <div style={viewerWrap}>
          {/* Oyunun gerçek viewer'ı: src değişince remount için key */}
          <Panorama360
            key={scene.id}
            src={scene.imagePath}
            attribution={scene.attribution}
            mirrorX={scene.sourceType === "real_world"}
          />
        </div>

        <section style={meta}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", alignItems: "baseline" }}>
            <strong style={{ fontSize: 15 }}>{scene.title}</strong>
            <span style={{ color: "#9aa7b4" }}>
              {scene.regionLabel} · {scene.yearLabel} · zorluk: {scene.difficulty}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#9aa7b4", marginTop: 6 }}>
            <div>
              <b>Kaynak:</b> {scene.attribution?.source ?? "—"} ·{" "}
              <b>Görsel:</b>{" "}
              {imgInfo
                ? `${imgInfo.w}×${imgInfo.h}${imgInfo.kb != null ? ` · ${(imgInfo.kb / 1024).toFixed(2)} MB` : ""}`
                : "ölçülüyor…"}
            </div>
            <div style={{ marginTop: 4 }}>
              <b>Atıf:</b> {scene.attribution?.author} · {scene.attribution?.license}
              {scene.attribution?.captureDate ? ` · ${scene.attribution.captureDate}` : ""} ·{" "}
              <a href={scene.attribution?.attributionUrl} target="_blank" rel="noopener noreferrer"
                 style={{ color: "#4493f8" }}>
                kaynak ↗
              </a>
              {scene.attribution?.modified ? " · (4096×2048'e resize)" : ""}
            </div>
            <div style={{ marginTop: 4 }}>
              <b>Kategoriler:</b> {scene.categories.join(", ")}
            </div>
            <div style={{ marginTop: 4 }}>
              <b>Yasaklı kelimeler ({scene.bannedWords.length}):</b> {scene.bannedWords.join(", ")}
            </div>
            <div style={{ marginTop: 4 }}>
              <b>imagePath:</b> <code>{scene.imagePath}</code>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
