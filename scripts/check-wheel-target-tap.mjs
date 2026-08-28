/**
 * check-wheel-target-tap — "Çark'ta HEDEF ülke telefonda tıklanamıyor" iddiasının
 * ölçümü.
 *
 * Build 9 gerçek-cihaz raporu: iPhone'da çarkın seçtiği DOĞRU ülkeye
 * dokunulamıyor, YANLIŞ ülkeler dokunulabiliyor. Bu script iddianın harita
 * katmanında olup olmadığını kanıtlar/çürütür: üretimdeki Çark Düello DOM'unu
 * (wd-screen → wd-hud + wd-map → floating .wd-player-card + WorldMap) telefon
 * (390x844) ve masaüstü (1280x800) çerçevelerinde mount eder ve
 *
 *   1) HER ülke için poligonun İÇİNDE gerçek bir nokta bulur
 *      (SVGGeometryElement.isPointInFill — bbox merkezi multipolygon'da
 *      denizde kalabilir) ve document.elementFromPoint ile o noktanın
 *      gerçekten o ülkeye çözüldüğünü doğrular. Çözülmüyorsa ARAYA GİREN
 *      elemanı raporlar. Bu, "overlay hedefi yutuyor" hipotezini tüm harita
 *      için tek seferde test eder.
 *   2) Hedef ülkeye gerçek parmak dizisi gönderir (merkez + sınıra yakın
 *      nokta + 8px titreme), YANLIŞ ülkeye de aynısını gönderir ve ikisinin
 *      de onCountryClick ürettiğini ölçer.
 *   3) Hedefin "used/last/wrong" durum sınıflarıyla (üretimde hedefin
 *      alabileceği tüm sınıflar) hâlâ tıklanabilir olduğunu doğrular.
 *   4) Pan'ın tıklamaya dönüşmediğini ve masaüstü davranışının değişmediğini
 *      doğrular.
 *
 *   Ön koşul: :5199'da bir dev sunucu  →  npx vite --port 5199
 *   Çalıştır: node scripts/check-wheel-target-tap.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN  = process.env.MAP_ORIGIN ?? "http://localhost:5199";
const PUBLIC  = new URL("../public/", import.meta.url).pathname;
const PORT    = 5214;
const PROFILE = mkdtempSync(join(tmpdir(), "wheel-tap-"));

/** Çarkın gerçekte seçebileceği, farklı büyüklük/konumda hedefler. */
/** topoId = sıfır dolgulu ISO-numeric (world-atlas feature.id).
 *  792 Türkiye · 276 Almanya · 076 Brezilya · 036 Avustralya ·
 *  392 Japonya · 818 Mısır · 578 Norveç · 356 Hindistan · 620 Portekiz. */
const TARGETS = ["792", "276", "076", "036", "392", "818", "578", "356", "620"];
const TARGET  = "792";   // sınır/durum testlerinin sabit hedefi (Türkiye)
const WRONG   = "076";   // aynı ekranda uzak bir "yanlış" ülke (Brezilya)

const SCENARIO = `
const out = [];
async function run() {
  const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail ?? "") });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const TARGETS = ${JSON.stringify(TARGETS)};
  const TARGET = ${JSON.stringify(TARGET)};
  const WRONG = ${JSON.stringify(WRONG)};

  function frame(query, w, h) {
    return new Promise(resolve => {
      const old = document.getElementById("f");
      if (old) old.remove();
      const f = document.createElement("iframe");
      f.id = "f"; f.style.width = w + "px"; f.style.height = h + "px";
      f.style.border = "0"; f.style.display = "block";
      f.src = "/mobile-map-dev?scene=wheelduel&" + query + "&t=" + Date.now();
      f.onload = () => {
        // Sentetik pointerId gerçek bir aktif pointer'a karşılık gelmediği için
        // setPointerCapture NotFoundError atar ve onPointerDown'ı ortasında
        // keser. No-op'a çeviriyoruz; capture'ın tek gözlemlenebilir etkisini
        // (sonraki olaylar svg'ye gider) zaten elle taklit ediyoruz.
        const El = f.contentWindow.Element.prototype;
        El.setPointerCapture = function () {};
        El.releasePointerCapture = function () {};
        El.hasPointerCapture = function () { return false; };
        setTimeout(() => resolve(f), 2600);
      };
      document.body.appendChild(f);
    });
  }
  const clicks = win => (win.__mapTest && win.__mapTest.countryClicks) || 0;
  const lastId = win => (win.__mapTest && win.__mapTest.lastCountryId) || null;

  function mkPe(doc, win, svg, pointerType) {
    return (type, id, x, y) => {
      const target = type === "pointerdown" ? (doc.elementFromPoint(x, y) || svg) : svg;
      target.dispatchEvent(new win.PointerEvent(type, {
        pointerId: id, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
        bubbles: true, cancelable: true, isPrimary: id === 1, pointerType,
      }));
    };
  }

  /** Poligonun İÇİNDE, ekran koordinatında bir nokta bul (isPointInFill).
   *  Multipolygon'da bbox merkezi denize düşebildiği için ızgara taranır. */
  function interiorPoint(win, doc, path) {
    const svg = doc.querySelector(".world-svg");
    // Nokta HARİTA ALANININ içinde olmalı: HUD şeridinin altındaki bant.
    // (Aksi hâlde test kendi ölçüm hatasını ürün hatası sanır.)
    const area = doc.querySelector(".wd-map").getBoundingClientRect();
    const box = path.getBBox();
    const id  = path.getAttribute("data-topo-id");
    const pt = svg.createSVGPoint();
    const toScreen = path.getScreenCTM();
    if (!toScreen) return null;
    const N = 15;
    let best = null;      // hem dolgu İÇİNDE hem de EN ÜSTTE olan nokta
    let fallback = null;  // dolgu içinde ama üstü örtülü (görünmeyen) nokta
    for (let iy = 1; iy < N; iy++) {
      for (let ix = 1; ix < N; ix++) {
        pt.x = box.x + (box.width  * ix) / N;
        pt.y = box.y + (box.height * iy) / N;
        if (!path.isPointInFill(pt)) continue;
        const s = pt.matrixTransform(toScreen);
        if (s.x < area.left + 2 || s.x > area.right  - 2) continue;
        if (s.y < area.top  + 2 || s.y > area.bottom - 2) continue;
        const cand = { x: Math.round(s.x), y: Math.round(s.y), d: Math.hypot(ix - N / 2, iy - N / 2) };
        // "Tıklanabilir" demek = O NOKTADA GÖRÜNEN ülke benim demektir.
        // Basitçe "dolgumun içinde" yetmez: dünya-atlası basitleştirilmiş
        // poligonlarında küçük komşular (Sierra Leone/Gine, Lesotho/G.Afrika)
        // birbirinin kutusuyla çakışır ve o noktada ÜSTTEKİ ülke doğrudur.
        const hit = doc.elementFromPoint(cand.x, cand.y);
        const hitId = hit && hit.getAttribute ? hit.getAttribute("data-topo-id") : null;
        if (hitId === id) { if (!best || cand.d < best.d) best = cand; }
        else if (!fallback || cand.d < fallback.d) fallback = cand;
      }
    }
    // best yoksa ülke hiçbir noktasında GÖRÜNMÜYOR demektir → çağıran bunu
    // "ulaşılamaz" olarak raporlar (fallback yalnız teşhis için döner).
    return best ?? (fallback ? { ...fallback, occluded: true } : null);
  }

  /** elementFromPoint yığınının tamamı — araya giren katmanı ADIYLA gösterir. */
  function stackAt(doc, x, y) {
    return Array.from(doc.elementsFromPoint(x, y)).slice(0, 4).map(describe).join(" > ");
  }

  function describe(el) {
    if (!el) return "null";
    const cls = (el.getAttribute && el.getAttribute("class")) || el.className || "";
    const id = el.getAttribute && el.getAttribute("data-topo-id");
    return el.tagName + (id ? "[" + id + "]" : "") + (cls ? "." + String(cls).trim().split(/\\s+/).join(".") : "");
  }

  /** Bu çerçevede ekranda olan (iç noktası bulunabilen) ülkeler. Telefon
   *  başlangıç kamerası (initialTransform, k>1 + kuzey bias) dünyanın bir
   *  kısmını çerçeve dışında bırakır — bu ÜRÜNÜN davranışı, testin değil. */
  function onScreen(win, doc) {
    const m = new Map();
    for (const p of doc.querySelectorAll("path[data-topo-id]")) {
      const id = p.getAttribute("data-topo-id");
      // Boş data-topo-id: uygulamanın ülke listesinde karşılığı olmayan
      // topoloji parçası (out-of-scope çizilir). Geçerli bir cevap değildir,
      // dolayısıyla tıklanamaz olması DOĞRUDUR.
      if (!id) continue;
      const pt = interiorPoint(win, doc, p);
      if (pt) m.set(id, { path: p, pt });
    }
    return m;
  }

  /* ═══════════ 1. TELEFON — TÜM HARİTA HIT-TEST TARAMASI ═══════════
     "Bir overlay hedefi yutuyor" hipotezi: eğer doğruysa en az bir ülkenin
     iç noktası kendi <path>'ine ÇÖZÜLMEZ. Tüm ülkeler için ölçülür. */
  {
    const f = await frame("target=" + TARGET, 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    ok("telefon: Çark Düello haritası mount oldu", !!svg, svg ? "ok" : "world-svg yok");
    if (!svg) return out;
    ok("telefon: floating oyuncu kartı üretimdeki gibi mount edildi",
       !!doc.querySelector(".wd-player-card"), "var");
    ok("telefon: hedef HUD'da görünüyor",
       doc.querySelector(".wd-target") && doc.querySelector(".wd-target").textContent.length > 0,
       doc.querySelector(".wd-target") ? doc.querySelector(".wd-target").textContent : "yok");

    const paths = Array.from(doc.querySelectorAll("path[data-topo-id]"));
    ok("telefon: ülke poligonları çizildi", paths.length > 150, paths.length + " path");

    const visible = onScreen(win, doc);
    const intercepted = [];
    let probed = 0;
    for (const [, v] of visible) {
      const p = v.path, pt = v.pt;
      probed++;
      const hit = doc.elementFromPoint(pt.x, pt.y);
      if (hit === p) continue;
      // Aynı ülkenin başka bir parçası da doğru cevaptır (multipolygon).
      if (hit && hit.getAttribute && hit.getAttribute("data-topo-id") === p.getAttribute("data-topo-id")) continue;
      intercepted.push(p.getAttribute("data-topo-id") + " @" + pt.x + "," + pt.y
                       + " -> " + stackAt(doc, pt.x, pt.y));
    }
    ok("telefon: taranan ülke sayısı anlamlı", probed > 80, probed + " ülke ekranda test edildi");
    ok("telefon: ekrandaki HER ülkenin GÖRÜNÜR (üstte) bir dokunma noktası var",
       intercepted.length === 0,
       intercepted.length === 0 ? probed + " ülkenin hepsi kendi poligonuna çözüldü (overlay yutması yok)"
                                : intercepted.length + " ülke engellendi: " + intercepted.slice(0, 8).join(" | "));

    // ── EKRANDAKİ HER ülkeye gerçek parmak dizisi (8px titremeyle) ──
    // Çark hedefi bu havuzdan çıkar; "hedef tıklanamıyor" iddiası doğruysa
    // en az bir ülke burada düşer.
    // Kıpırdamayan dokunuş: her ülke için nokta TAM ÖNCE yeniden hesaplanır —
    // WorldMap eşik altı hareketi de pan'a çevirdiği için önceden toplanan
    // koordinatlar bayatlar (bu ürünün davranışı, ölçüm bunu kabul eder).
    const pe = mkPe(doc, win, svg, "touch");
    const failedTaps = [];
    let tapped = 0, pid = 100;
    for (const id of Array.from(visible.keys())) {
      const p = doc.querySelector('path[data-topo-id="' + id + '"]');
      const pt = interiorPoint(win, doc, p);
      if (!pt || pt.occluded) continue;
      const before = clicks(win);
      pid++;
      pe("pointerdown", pid, pt.x, pt.y); await sleep(5);
      pe("pointerup",   pid, pt.x, pt.y); await sleep(6);
      tapped++;
      if (clicks(win) !== before + 1 || lastId(win) !== id) {
        failedTaps.push(id + " @" + pt.x + "," + pt.y + " -> " + lastId(win)
                        + " [" + stackAt(doc, pt.x, pt.y) + "]");
      }
    }
    ok("telefon: ekrandaki HER ülke dokunuşla seçilebiliyor",
       failedTaps.length === 0,
       failedTaps.length === 0 ? tapped + " ülkenin hepsi seçildi"
                               : failedTaps.length + "/" + tapped + " düştü: " + failedTaps.slice(0, 6).join(" | "));

    // Aynı ülkelere 8px parmak titremesiyle (gerçek dokunuş profili).
    const failedJitter = [];
    let jittered = 0;
    for (const id of Array.from(visible.keys())) {
      const p = doc.querySelector('path[data-topo-id="' + id + '"]');
      const pt = interiorPoint(win, doc, p);
      if (!pt || pt.occluded) continue;
      // Yön dönüşümlü: WorldMap eşik ALTI hareketi de pan'a çevirir, hep aynı
      // yöne titretmek 97 dokunuş boyunca haritayı kaydırıp clampPan'a
      // dayandırırdı (testin kendi artefaktı).
      const dir = jittered % 2 === 0 ? 1 : -1;
      const upX = pt.x + 5 * dir, upY = pt.y + 3 * dir;
      const before = clicks(win);
      pid++;
      pe("pointerdown", pid, pt.x, pt.y); await sleep(5);
      pe("pointermove", pid, pt.x + 3 * dir, pt.y + 2 * dir);
      pe("pointermove", pid, upX, upY);
      // React'in setXf flush'ını bekle: gerçek parmakta move ve up ARASINDA
      // en az bir frame vardır. Aynı tick'te göndermek haritayı henüz
      // kaydırmamış DOM'a karşı elementFromPoint çalıştırır.
      await sleep(40);
      // ÖLÇÜLEN ŞEY: 8px titreme SÜRÜKLEME sanılıp dokunuşun YUTULMAMASI
      // (build 7/8'in 5px eşiği tam olarak bunu yapıyordu). Bırakma noktası
      // artık denize/kimliksiz parçaya düşüyorsa hiçbir ülke seçilmemesi
      // DOĞRUDUR — o geometridir, eşik davranışı değil; o örnek atlanır.
      const upEl = doc.elementFromPoint(upX, upY);
      const upId = upEl && upEl.getAttribute ? upEl.getAttribute("data-topo-id") : null;
      if (!upId) { pe("pointerup", pid, upX, upY); await sleep(6); continue; }
      pe("pointerup", pid, upX, upY); await sleep(10);
      jittered++;
      if (clicks(win) !== before + 1) {
        failedJitter.push(id + " @" + upX + "," + upY + " (bırakma: " + upId + ") -> seçim yok");
      }
    }
    ok("telefon: 8px parmak titremeli dokunuş yutulmuyor (her zaman bir seçim üretir)",
       failedJitter.length === 0,
       failedJitter.length === 0 ? jittered + " ülkenin hepsi seçildi"
                                 : failedJitter.length + "/" + jittered + " düştü: " + failedJitter.slice(0, 6).join(" | "));

    // ── Çarkın seçebileceği bilinen hedefler (ekranda olanlar) ──
    const known = TARGETS.filter(t => visible.has(t));
    const failedTargets = [];
    for (const t of known) {
      const pt = interiorPoint(win, doc, doc.querySelector('path[data-topo-id="' + t + '"]'));
      if (!pt) continue;   // sweep pan'ı ekran dışına taşıdı — ayrı sahnelerde tek tek ölçülür
      if (pt.occluded) { failedTargets.push(t + " (görünmüyor)"); continue; }
      const before = clicks(win);
      pid++;
      pe("pointerdown", pid, pt.x, pt.y); await sleep(15);
      pe("pointerup",   pid, pt.x, pt.y); await sleep(20);
      if (clicks(win) !== before + 1 || lastId(win) !== t) {
        failedTargets.push(t + " -> " + lastId(win));
      }
    }
    ok("telefon: bilinen çark hedefleri (ekrandakiler) seçilebiliyor",
       known.length > 0 && failedTargets.length === 0,
       "ekranda " + known.join(",") + (failedTargets.length ? " | DÜŞTÜ: " + failedTargets.join(" | ") : ""));
  }

  /* ═══════════ 2. TELEFON — HEDEF SINIRA YAKIN DOKUNUŞ ═══════════ */
  {
    const f = await frame("target=" + TARGET, 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    const pe = mkPe(doc, win, svg, "touch");
    const p = doc.querySelector('path[data-topo-id="' + TARGET + '"]');
    const box = p.getBBox();
    const toScreen = p.getScreenCTM();
    const pt = svg.createSVGPoint();
    // Sınıra yakın iç nokta: bbox kenarından içeri doğru ilk dolu piksel.
    let edge = null;
    for (let f2 = 0.02; f2 < 0.5 && !edge; f2 += 0.02) {
      pt.x = box.x + box.width * f2;
      pt.y = box.y + box.height * 0.5;
      if (p.isPointInFill(pt)) {
        const s = pt.matrixTransform(toScreen);
        edge = { x: Math.round(s.x), y: Math.round(s.y) };
      }
    }
    ok("telefon: hedefin sınıra yakın iç noktası bulundu", !!edge, edge ? edge.x + "," + edge.y : "yok");
    if (edge) {
      const before = clicks(win);
      pe("pointerdown", 5, edge.x, edge.y); await sleep(20);
      pe("pointerup",   5, edge.x, edge.y); await sleep(35);
      ok("telefon: hedefin SINIRINA dokunuş hedefi seçer",
         clicks(win) === before + 1 && lastId(win) === TARGET,
         "clicks " + before + "->" + clicks(win) + ", id=" + lastId(win));
    }
  }

  /* ═══════════ 3. TELEFON — HEDEF used/last/wrong SINIFLARIYLA ═══════════
     Üretimde hedef ülke aynı anda .guessed (used dizisinde), .last (son doğru)
     ya da .wheel-wrong (kırmızı flash) sınıfını alabilir. Hiçbiri hit-test'i
     değiştirmemeli. */
  {
    const f = await frame("target=" + TARGET + "&used=" + TARGET + "&last=" + TARGET + "&wrong=" + TARGET, 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    const pe = mkPe(doc, win, svg, "touch");
    const p = doc.querySelector('path[data-topo-id="' + TARGET + '"]');
    ok("telefon: hedef üç durum sınıfını birden taşıyor",
       p && /guessed/.test(p.getAttribute("class")) && /last/.test(p.getAttribute("class"))
         && /wheel-wrong/.test(p.getAttribute("class")),
       p ? p.getAttribute("class") : "yok");
    const pt = interiorPoint(win, doc, p);
    const hit = pt ? doc.elementFromPoint(pt.x, pt.y) : null;
    ok("telefon: durum sınıflarıyla da hedef kendi poligonuna çözülüyor",
       hit === p, describe(hit));
    if (pt) {
      const before = clicks(win);
      pe("pointerdown", 7, pt.x, pt.y); await sleep(20);
      pe("pointerup",   7, pt.x, pt.y); await sleep(35);
      ok("telefon: guessed+last+wrong durumundaki hedef HÂLÂ seçilebiliyor",
         clicks(win) === before + 1 && lastId(win) === TARGET,
         "clicks " + before + "->" + clicks(win) + ", id=" + lastId(win));
    }
  }

  /* ═══════════ 4. TELEFON — YANLIŞ ÜLKE + PAN ═══════════ */
  {
    const f = await frame("target=" + TARGET, 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    const pe = mkPe(doc, win, svg, "touch");
    const wrongPath = doc.querySelector('path[data-topo-id="' + WRONG + '"]');
    const wp = interiorPoint(win, doc, wrongPath);
    ok("telefon: yanlış ülke ekranda ve iç noktası bulundu", !!wp, wp ? wp.x + "," + wp.y : "ekran dışı");
    if (!wp) return out;
    const b0 = clicks(win);
    pe("pointerdown", 9, wp.x, wp.y); await sleep(20);
    pe("pointerup",   9, wp.x, wp.y); await sleep(35);
    ok("telefon: YANLIŞ ülke de seçilebiliyor (asimetri yok)",
       clicks(win) === b0 + 1 && lastId(win) === WRONG,
       "clicks " + b0 + "->" + clicks(win) + ", id=" + lastId(win));

    const tp = interiorPoint(win, doc, doc.querySelector('path[data-topo-id="' + TARGET + '"]'));
    if (!tp) { ok("telefon: pan testi için hedef ekranda", false, "ekran dışı"); return out; }
    const b1 = clicks(win);
    pe("pointerdown", 11, tp.x, tp.y);
    for (let i = 1; i <= 8; i++) pe("pointermove", 11, tp.x + i * 15, tp.y + i * 4);
    pe("pointerup", 11, tp.x + 120, tp.y + 32); await sleep(40);
    ok("telefon: hedef üzerinden başlayan PAN tıklamaya dönüşmüyor",
       clicks(win) === b1, "clicks " + b1 + " -> " + clicks(win));
  }

  /* ═══════════ 5. MASAÜSTÜ — DEĞİŞMEDİ ═══════════ */
  {
    const f = await frame("target=" + TARGET, 1280, 800);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    const pe = mkPe(doc, win, svg, "mouse");
    ok("masaüstü: +/- zoom kontrolü DURUYOR", !!doc.querySelector(".zoom-controls"), "var");
    const p = doc.querySelector('path[data-topo-id="' + TARGET + '"]');
    const pt = interiorPoint(win, doc, p);
    ok("masaüstü: hedefin iç noktası bulundu", !!pt, pt ? pt.x + "," + pt.y : "yok");
    if (!pt) return out;
    const b = clicks(win);
    pe("pointerdown", 21, pt.x, pt.y); await sleep(20);
    pe("pointerup",   21, pt.x, pt.y); await sleep(35);
    ok("masaüstü: fare tıklaması hedefi seçer",
       clicks(win) === b + 1 && lastId(win) === TARGET,
       "clicks " + b + "->" + clicks(win) + ", id=" + lastId(win));
    const b2 = clicks(win);
    pe("pointerdown", 22, pt.x, pt.y); await sleep(20);
    pe("pointermove", 22, pt.x + 5, pt.y + 3);
    pe("pointerup",   22, pt.x + 5, pt.y + 3); await sleep(35);
    ok("masaüstü: fare 8px hareketi HÂLÂ sürükleme (eşik 5px değişmedi)",
       clicks(win) === b2, "clicks " + b2 + " -> " + clicks(win));
  }

  return out;
}
run()
  .catch(e => { out.push({ name: "scenario çöktü", pass: false, detail: e.message + " @ " + e.stack }); })
  .then(() => fetch("http://localhost:${PORT}/", { method: "POST", body: JSON.stringify(out) }));
`;

const inbox = [];
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => { inbox.push(body); res.end("ok"); });
});
await new Promise(r => server.listen(PORT, r));

const wrapperPath = `${PUBLIC}__wheeltargettap.html`;
writeFileSync(wrapperPath, `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><script>setTimeout(function(){${SCENARIO}}, 300);</script></body></html>`);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--window-size=1400,900",
  `--user-data-dir=${PROFILE}`,
  `${ORIGIN}/__wheeltargettap.html`,
], { stdio: "ignore", detached: true });

const deadline = Date.now() + 180000;
while (inbox.length === 0 && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 300));
}
try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
try { execFileSync("pkill", ["-f", "headless"]); } catch { /* none running */ }
server.close();
try { unlinkSync(wrapperPath); } catch { /* already removed */ }

if (inbox.length === 0) {
  console.error("FAIL: sayfadan sonuç gelmedi (dev sunucu " + ORIGIN + " üzerinde mi?)");
  process.exit(1);
}

const results = JSON.parse(inbox[0]);
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "  ok  " : "FAIL  "} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} assertion geçti`);
process.exit(failed === 0 ? 0 : 1);
