/**
 * check-mobile-map-interaction — TestFlight build 7 telefon harita düzeltmeleri
 * için davranışsal koruma.
 *
 * Regresyona uğradığında oyunu bozan kurallar burada:
 *   • Parmakla yapılan gerçek bir dokunuş ülke seçmeli. iPhone'da parmak izi
 *     bası ve kalkışı arasında birkaç piksel kayar; eski 5px eşiği bu
 *     dokunuşları "sürükleme" sayıp düşürüyordu ve harita tıklanamaz
 *     hissettiriyordu. Hiçbir reducer testi bunu yakalayamaz — hata pointer
 *     dizilişinde yaşıyor.
 *   • Masaüstü fare eşiği DEĞİŞMEMELİ (5px).
 *   • Gerçek sürükleme asla tıklamaya dönüşmemeli.
 *   • Telefonda +/- kontrolleri DOM'da olmamalı (elementFromPoint onları ülke
 *     yerine çözüyordu), masaüstünde durmalı.
 *   • Rota kamerası mevcut ülkeye oturmalı, ülke değişince takip etmeli, ama
 *     oyuncu eliyle pan yaptıktan sonra onu zorla geri çekmemeli.
 *
 * Gerçek bileşenleri /mobile-map-dev harness'inde, headless Chrome'da,
 * iframe'i telefon (390x844) ve masaüstü (1280x800) boyutunda açarak sürer —
 * useMobileSurface() matchMedia okuduğu için yüzeyi iframe genişliği belirler.
 *
 *   Ön koşul: :5199'da bir dev sunucu  →  npx vite --port 5199
 *   Çalıştır: node scripts/check-mobile-map-interaction.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN  = process.env.MAP_ORIGIN ?? "http://localhost:5199";
const PUBLIC  = new URL("../public/", import.meta.url).pathname;
const PORT    = 5213;
const PROFILE = mkdtempSync(join(tmpdir(), "map-touch-"));

// Tüm senaryo tek string: jest gibi izole değil, tek saat ve tek pointer-id
// uzayı paylaşan gerçek bir oturum.
const SCENARIO = `
async function run() {
  const out = [];
  const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail ?? "") });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── iframe yardımcıları ───────────────────────────────────────────────
  function frame(scene, w, h) {
    return new Promise(resolve => {
      const old = document.getElementById("f");
      if (old) old.remove();
      const f = document.createElement("iframe");
      f.id = "f"; f.style.width = w + "px"; f.style.height = h + "px";
      f.style.border = "0"; f.style.display = "block";
      f.src = "/mobile-map-dev?scene=" + scene + "&t=" + Date.now();
      f.onload = () => {
        // Sentetik PointerEvent'lerin pointerId'si gerçek bir aktif pointer'a
        // karşılık gelmediği için setPointerCapture NotFoundError atar ve
        // onPointerDown'ı ortasında keser — o zaman her jest tıklamaya
        // dönüşür ve test yalancı sonuç verir. No-op'a çeviriyoruz; capture'ın
        // TEK gözlemlenebilir etkisi olan "sonraki olaylar yakalayan elemana
        // gider" davranışını zaten move/up'ı doğrudan svg'ye göndererek
        // taklit ediyoruz. Ürün kodu değişmiyor.
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

  // Pointer capture gerçek tarayıcıda down'dan sonra tüm olayları yakalayan
  // elemana yönlendirir; svg .setPointerCapture çağırdığı için move/up doğrudan
  // svg'ye gider, down ise en derin elemana.
  function mkPe(doc, win, svg, pointerType) {
    return (type, id, x, y) => {
      const target = type === "pointerdown" ? (doc.elementFromPoint(x, y) || svg) : svg;
      target.dispatchEvent(new win.PointerEvent(type, {
        pointerId: id, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
        bubbles: true, cancelable: true, isPrimary: id === 1, pointerType,
      }));
    };
  }
  function xform(win, g) {
    const m = new win.DOMMatrixReadOnly(win.getComputedStyle(g).transform);
    return { k: +m.a.toFixed(3), x: +m.e.toFixed(1), y: +m.f.toFixed(1) };
  }

  /* ═══════════ 1. ÇARK — TELEFON (390x844) ═══════════ */
  {
    const f = await frame("wheel", 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    ok("çark/telefon: harita mount oldu", !!svg, svg ? "ok" : "world-svg yok");
    if (!svg) return out;

    ok("çark/telefon: +/- zoom kontrolü DOM'da yok",
       !doc.querySelector(".zoom-controls"), doc.querySelector(".zoom-controls") ? "hâlâ var" : "yok");
    ok("çark/telefon: scroll/zoom ipucu yok",
       !doc.querySelector(".map-hint"), doc.querySelector(".map-hint") ? "hâlâ var" : "yok");
    ok("çark/telefon: pinch için tema seçici korunuyor (tasarım özelliği)",
       !!doc.querySelector(".map-theme-picker"), "korundu");

    const cont = doc.querySelector(".map-container-inner");
    ok("çark/telefon: kapsayıcı is-mobile-map sınıfını taşıyor",
       cont && cont.classList.contains("is-mobile-map"), cont ? cont.className : "yok");
    const cs = win.getComputedStyle(cont);
    ok("çark/telefon: iOS metin seçimi kapalı",
       cs.webkitUserSelect === "none" || cs.userSelect === "none",
       "user-select=" + (cs.webkitUserSelect || cs.userSelect));

    const pe = mkPe(doc, win, svg, "touch");
    // Ülke dolu bir nokta seç: haritanın ortasından tarayıp ilk country-path'i bul.
    let tx = 0, ty = 0;
    for (let yy = 200; yy < 700 && !tx; yy += 7) {
      for (let xx = 20; xx < 370; xx += 7) {
        const el = doc.elementFromPoint(xx, yy);
        if (el && el.tagName === "path" && el.getAttribute("data-topo-id")) { tx = xx; ty = yy; break; }
      }
    }
    ok("çark/telefon: haritada ülke poligonu bulundu", tx > 0, tx + "," + ty);

    // ── gerçek parmak dokunuşu: 8px jitter (eski 5px eşiğinde DÜŞERDİ) ──
    const b1 = clicks(win);
    pe("pointerdown", 1, tx, ty); await sleep(25);
    pe("pointermove", 1, tx + 3, ty + 2);
    pe("pointermove", 1, tx + 5, ty + 3);
    pe("pointerup",   1, tx + 5, ty + 3); await sleep(40);
    ok("çark/telefon: 8px parmak titremesiyle dokunuş ülkeyi SEÇER",
       clicks(win) === b1 + 1, "clicks " + b1 + " -> " + clicks(win));

    // ── 13px: hâlâ dokunuş (14px eşiğinin hemen altı) ──
    const b1b = clicks(win);
    pe("pointerdown", 2, tx, ty); await sleep(20);
    pe("pointermove", 2, tx + 7, ty + 6);
    pe("pointerup",   2, tx + 7, ty + 6); await sleep(40);
    ok("çark/telefon: 13px titreme hâlâ dokunuş sayılır",
       clicks(win) === b1b + 1, "clicks " + b1b + " -> " + clicks(win));

    // ── gerçek sürükleme: 120px → tıklama OLMAMALI, harita kaymalı ──
    const g = doc.querySelector(".world-svg > g");
    const before = xform(win, g);
    const b2 = clicks(win);
    pe("pointerdown", 3, tx, ty);
    for (let i = 1; i <= 8; i++) pe("pointermove", 3, tx + i * 15, ty + i * 4);
    pe("pointerup", 3, tx + 120, ty + 32); await sleep(40);
    const after = xform(win, g);
    ok("çark/telefon: gerçek sürükleme ülke SEÇMEZ",
       clicks(win) === b2, "clicks " + b2 + " -> " + clicks(win));
    ok("çark/telefon: sürükleme haritayı kaydırır (pan korunuyor)",
       Math.abs(after.x - before.x) > 20, JSON.stringify(before) + " -> " + JSON.stringify(after));

    // ── pinch: zoom değişmeli, tıklama olmamalı ──
    const b3 = clicks(win);
    const k0 = xform(win, g).k;
    const cx = 195, cy = 420;
    pe("pointerdown", 10, cx - 40, cy);
    pe("pointerdown", 11, cx + 40, cy);
    for (let i = 1; i <= 5; i++) {
      pe("pointermove", 10, cx - 40 - i * 16, cy);
      pe("pointermove", 11, cx + 40 + i * 16, cy);
    }
    pe("pointerup", 10, cx - 120, cy);
    pe("pointerup", 11, cx + 120, cy); await sleep(40);
    const k1 = xform(win, g).k;
    ok("çark/telefon: pinch yakınlaştırır", k1 > k0 * 1.2, k0 + " -> " + k1);
    ok("çark/telefon: pinch ülke SEÇMEZ", clicks(win) === b3, "clicks " + b3 + " -> " + clicks(win));
  }

  /* ═══════════ 2. ÇARK — MASAÜSTÜ (1280x800) ═══════════ */
  {
    const f = await frame("wheel", 1280, 800);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    ok("çark/masaüstü: +/- zoom kontrolü DURUYOR",
       !!doc.querySelector(".zoom-controls"), doc.querySelector(".zoom-controls") ? "var" : "KAYBOLDU");
    ok("çark/masaüstü: sürükle/scroll ipucu DURUYOR",
       !!doc.querySelector(".map-hint"), doc.querySelector(".map-hint") ? "var" : "KAYBOLDU");
    const cont = doc.querySelector(".map-container-inner");
    ok("çark/masaüstü: is-mobile-map sınıfı YOK",
       cont && !cont.classList.contains("is-mobile-map"), cont ? cont.className : "yok");
    const cs = win.getComputedStyle(cont);
    ok("çark/masaüstü: metin seçimi sertleştirmesi uygulanmadı",
       cs.webkitUserSelect !== "none" && cs.userSelect !== "none",
       "user-select=" + (cs.webkitUserSelect || cs.userSelect));

    const pe = mkPe(doc, win, svg, "mouse");
    let tx = 0, ty = 0;
    for (let yy = 200; yy < 640 && !tx; yy += 9) {
      for (let xx = 40; xx < 1240; xx += 9) {
        const el = doc.elementFromPoint(xx, yy);
        if (el && el.tagName === "path" && el.getAttribute("data-topo-id")) { tx = xx; ty = yy; break; }
      }
    }
    // Fare eşiği 5px'te kalmalı: 8px hareket masaüstünde HÂLÂ sürükleme.
    const b = clicks(win);
    pe("pointerdown", 20, tx, ty); await sleep(20);
    pe("pointermove", 20, tx + 5, ty + 3);
    pe("pointerup",   20, tx + 5, ty + 3); await sleep(40);
    ok("çark/masaüstü: fare 8px hareketi HÂLÂ sürükleme (eşik 5px değişmedi)",
       clicks(win) === b, "clicks " + b + " -> " + clicks(win));
    // Kıpırdamayan fare tıklaması seçmeli.
    const b2 = clicks(win);
    pe("pointerdown", 21, tx, ty); await sleep(20);
    pe("pointerup",   21, tx, ty); await sleep(40);
    ok("çark/masaüstü: sabit fare tıklaması ülkeyi seçer",
       clicks(win) === b2 + 1, "clicks " + b2 + " -> " + clicks(win));
  }

  /* ═══════════ 3. ROTA KAMERASI — TELEFON ═══════════ */
  {
    const f = await frame("route", 390, 520);
    const doc = f.contentDocument, win = f.contentWindow;
    const svg = doc.querySelector(".world-svg");
    ok("rota/telefon: harita mount oldu", !!svg, svg ? "ok" : "yok");
    if (!svg) return out;
    ok("rota/telefon: +/- zoom kontrolü yok",
       !doc.querySelector(".zoom-controls"), doc.querySelector(".zoom-controls") ? "hâlâ var" : "yok");

    const g = doc.querySelector(".world-svg > g");
    // RouteMapView mevcut ülkeyi .rt-current ile işaretler — testin ürünle
    // paylaştığı tek kanca bu; "kamera MEVCUT ülkeyi çerçeveliyor" iddiasının
    // doğru semantiği de bu.
    //
    // Ölçüm elementFromPoint ile yapılır, getBoundingClientRect ile DEĞİL:
    // multipolygon bir <path>'in kutusu denizaşırı parçalarını da kapsar
    // (Fransa'nın kutusu 544px, anakarası k=9'da 96px), yani kutu merkezi
    // hiçbir şey söylemez. Ekranın ortasında hangi ülkenin durduğu söyler.
    const isCurrentAt = (x, y) => {
      const el = doc.elementFromPoint(x, y);
      return !!el && el.classList && el.classList.contains("rt-current");
    };
    const centreHasCurrent = () =>
      isCurrentAt(Math.round(win.innerWidth / 2), Math.round(win.innerHeight / 2));
    // Kenarda mevcut ülke OLMAMALI: padding var, yani komşular görünüyor.
    const edgeIsClear = () =>
      !isCurrentAt(6, Math.round(win.innerHeight / 2))
      && !isCurrentAt(win.innerWidth - 6, Math.round(win.innerHeight / 2));
    const currentWidth = () => {
      const p = doc.querySelector(".country-path.rt-current");
      return p ? +p.getBoundingClientRect().width.toFixed(0) : -1;
    };
    const fit0 = xform(win, g);
    ok("rota/telefon: kamera dünya görünümünde kalmadı (yakınlaştı)",
       fit0.k > 3, "k=" + fit0.k);
    ok("rota/telefon: mevcut ülke (Bulgaristan) ekran merkezinde",
       centreHasCurrent(), "merkezde " + (doc.elementFromPoint(195, 260) || {}).className);
    ok("rota/telefon: çevresinde komşular için yer var (kenarda değil)",
       edgeIsClear(), "genişlik " + currentWidth() + "px / çerçeve " + win.innerWidth + "px");

    // ── mevcut ülke değişince kamera takip eder ──
    win.__mapTest.setRoute(["Bulgaria", "Turkey"]);
    await sleep(700);
    const fit1 = xform(win, g);
    ok("rota/telefon: yeni mevcut ülkede kamera taşındı",
       Math.abs(fit1.x - fit0.x) > 20 || Math.abs(fit1.y - fit0.y) > 20,
       JSON.stringify(fit0) + " -> " + JSON.stringify(fit1));
    ok("rota/telefon: kamera yeni mevcut ülkeyi (Türkiye) merkezler",
       centreHasCurrent(), "genişlik " + currentWidth() + "px");

    // ── Fransa: denizaşırı parçalar yüzünden dünya görünümüne kaçmamalı ──
    win.__mapTest.setRoute(["Bulgaria", "Turkey", "France"]);
    await sleep(700);
    const fitFr = xform(win, g);
    ok("rota/telefon: Fransa'da (multipolygon) dünyaya zoom-out YOK",
       fitFr.k > 5, "k=" + fitFr.k + " (tüm parçalarla çerçevelense k~2 olurdu)");
    ok("rota/telefon: Fransa ANAKARASI merkezde (Guyane değil)",
       centreHasCurrent(), "merkezde " + (doc.elementFromPoint(195, 260) || {}).className);

    // ── manuel pan sonrası kamera zorla geri çekilmemeli ──
    const pe = mkPe(doc, win, svg, "touch");
    const px = 195, py = 260;
    pe("pointerdown", 30, px, py);
    for (let i = 1; i <= 6; i++) pe("pointermove", 30, px - i * 18, py + i * 6);
    pe("pointerup", 30, px - 108, py + 36); await sleep(80);
    const panned = xform(win, g);
    ok("rota/telefon: manuel pan haritayı kaydırdı",
       Math.abs(panned.x - fitFr.x) > 20, JSON.stringify(fitFr) + " -> " + JSON.stringify(panned));
    // Boyut değişimi (klavye açılışı taklidi) — kullanıcı devraldığı için
    // kamera GERİ ÇEKMEMELİ.
    f.style.height = "300px"; await sleep(700);
    const afterResize = xform(win, g);
    ok("rota/telefon: manuel pan'dan sonra boyut değişimi kamerayı geri çekmez",
       Math.abs(afterResize.x - panned.x) < 2 && Math.abs(afterResize.k - panned.k) < 0.01,
       JSON.stringify(panned) + " -> " + JSON.stringify(afterResize));
    // Ama YENİ ülke auto-follow'u geri alır.
    win.__mapTest.setRoute(["Bulgaria", "Turkey", "France", "Spain"]);
    await sleep(700);
    ok("rota/telefon: yeni ülke auto-follow kilidini geri alır",
       centreHasCurrent(), "genişlik " + currentWidth() + "px");
  }

  /* ═══════════ 4. ROTA KAMERASI — MASAÜSTÜ DEĞİŞMEDİ ═══════════ */
  {
    const f = await frame("route", 1280, 700);
    const doc = f.contentDocument, win = f.contentWindow;
    const g = doc.querySelector(".world-svg > g");
    ok("rota/masaüstü: +/- zoom kontrolü DURUYOR",
       !!doc.querySelector(".zoom-controls"), doc.querySelector(".zoom-controls") ? "var" : "KAYBOLDU");
    const t = xform(win, g);
    ok("rota/masaüstü: kamera eski dünya görünümünde (k=1, kaydırma yok)",
       t.k === 1 && t.x === 0 && t.y === 0, JSON.stringify(t));
  }

  /* ═══════════ 5. ROTA OYUN EKRANI — TELEFON YERLEŞİMİ ═══════════ */
  {
    const f = await frame("play", 390, 844);
    const doc = f.contentDocument, win = f.contentWindow;
    const q = sel => doc.querySelector(sel);

    // Build 8'de burada "ince header" ölçülüyordu. O blok ARTIK HİÇ
    // ÇİZİLMİYOR: telefonda oyun sırasında tek şerit var (.rd-hud) ve geri
    // düğmesi onun içinde. Aşağıdaki iddialar yeni sözleşmeyi kilitler.
    ok("rota/oyun: mod etiketi/oda kodu/tur rozeti şeritte YOK",
       !q(".duel-mode-label") && !q(".duel-code-badge") && !q(".duel-region-badge"),
       [q(".duel-mode-label"), q(".duel-code-badge"), q(".duel-region-badge")].filter(Boolean).length + " kaldı");

    ok("rota/oyun: durum paneli (rd-hud) DURUYOR", !!q(".rd-hud"), q(".rd-hud") ? "var" : "yok");
    ok("rota/oyun: rd-hud tur bilgisini gösteriyor",
       q(".rd-round-chip") && /Tur 2 \\/ 5/.test(q(".rd-round-chip").textContent), q(".rd-round-chip") ? q(".rd-round-chip").textContent : "yok");
    ok("rota/oyun: rd-hud başlangıç→hedef gösteriyor",
       !!q(".rd-goal .route-start-label") && !!q(".rd-goal .route-target-label"), "var");
    ok("rota/oyun: SÜRE GÖSTERGESİ YOK (oyun içi süre sınırı kaldırıldı)",
       !q(".rd-timer"), q(".rd-timer") ? "hâlâ var: " + q(".rd-timer").textContent : "yok");
    ok("rota/oyun: rd-hud skor gösteriyor", !!q(".rd-score-pill"), "var");
    ok("rota/oyun: TEK HUD — ayrı .duel-header mount edilmiyor",
       !q(".duel-header"), q(".duel-header") ? "hâlâ var" : "yok");
    ok("rota/oyun: geri düğmesi HUD'un İÇİNDE",
       !!q(".rd-hud .rd-hud-back"), q(".rd-hud .rd-hud-back") ? "var" : "yok");
    ok("rota/oyun: HUD tek şerit (sarma yok)",
       q(".rd-hud").getBoundingClientRect().height < 56,
       q(".rd-hud").getBoundingClientRect().height.toFixed(1) + "px");
    ok("rota/oyun: harita HUD'un hemen altında (üstte boş koyu bant yok)",
       q(".route-map-area").getBoundingClientRect().top
         - q(".rd-hud").getBoundingClientRect().bottom < 2,
       (q(".route-map-area").getBoundingClientRect().top
         - q(".rd-hud").getBoundingClientRect().bottom).toFixed(1) + "px boşluk");
    ok("rota/oyun: rd-hud bağlantı durumu gösteriyor", !!q(".rd-conn"), q(".rd-conn") ? q(".rd-conn").textContent : "yok");

    ok("rota/oyun: haritada +/- zoom kontrolü yok",
       !q(".zoom-controls"), q(".zoom-controls") ? "hâlâ var" : "yok");

    const inp = q(".route-input");
    const btn = q(".route-input-row .btn-accent");
    const ir = inp.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    ok("rota/oyun: giriş alanı ve Gir düğmesi görünür",
       ir.height > 20 && br.height > 20 && ir.bottom <= win.innerHeight + 1,
       "input " + ir.height.toFixed(0) + "px alt=" + ir.bottom.toFixed(0)
       + ", btn " + br.height.toFixed(0) + "px, çerçeve=" + win.innerHeight);
    // Sanal klavye = webview küçülmesi (Capacitor Keyboard resize:'native').
    const mapBefore = q(".route-map-area").getBoundingClientRect().height;
    f.style.height = "440px"; await sleep(700);
    const ir2 = inp.getBoundingClientRect();
    const mapAfter = q(".route-map-area").getBoundingClientRect().height;
    ok("rota/oyun: klavye açıkken giriş alanı hâlâ görünür (taşma yok)",
       ir2.bottom <= win.innerHeight + 1 && ir2.height > 20,
       "input alt=" + ir2.bottom.toFixed(0) + " çerçeve alt=" + win.innerHeight);
    ok("rota/oyun: klavye açıkken haritaya hâlâ anlamlı yükseklik kalıyor",
       mapAfter > 120, mapBefore.toFixed(0) + "px -> " + mapAfter.toFixed(0) + "px");
    ok("rota/oyun: ziyaret zinciri tek satıra sabitlendi",
       q(".route-path-chips").getBoundingClientRect().height < 40,
       q(".route-path-chips").getBoundingClientRect().height.toFixed(1) + "px");
  }

  /* ═══════════ 6. HEADER: masaüstünde TAM, telefon+oyunda YOK ═══════════ */
  {
    // Telefon + oyun: header hiç yok (ölçüm 5'te doğrulandı). Masaüstü
    // genişliğinde aynı sahne header'ı GERİ getirmeli ve içeriğini korumalı.
    const wide = await frame("play", 1280, 800);
    const wdoc = wide.contentDocument;
    ok("header: masaüstünde .duel-header geri geliyor",
       !!wdoc.querySelector(".duel-header"), wdoc.querySelector(".duel-header") ? "var" : "yok");
    ok("header: masaüstü içeriği korunuyor (oda kodu)",
       !!wdoc.querySelector(".duel-header .duel-code-badge"), "oda kodu duruyor");
    ok("header: masaüstünde de süre göstergesi YOK",
       !wdoc.querySelector(".rd-timer"), "yok");
    ok("header: masaüstünde HUD içi geri düğmesi YOK (ayrı header var)",
       !wdoc.querySelector(".rd-hud-back"), "yok");

    const f = await frame("header", 390, 844);
    const doc = f.contentDocument;
    const full = doc.getElementById("full-header").getBoundingClientRect().height;
    ok("header: tam varyant masaüstü içeriğini koruyor",
       !!doc.querySelector("#full-header .duel-code-badge") && full > 0, full.toFixed(1) + "px");
  }

  return out;
}
run().then(r => fetch("http://localhost:${PORT}/", {
  method: "POST", body: JSON.stringify(r),
})).catch(e => fetch("http://localhost:${PORT}/", {
  method: "POST", body: JSON.stringify([{ name: "scenario", pass: false, detail: e.message + " @ " + e.stack }]),
}));
`;

const inbox = [];
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => { inbox.push(body); res.end("ok"); });
});
await new Promise(r => server.listen(PORT, r));

const wrapperPath = `${PUBLIC}__mapinteraction.html`;
writeFileSync(wrapperPath, `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><script>setTimeout(function(){${SCENARIO}}, 300);</script></body></html>`);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--window-size=1400,900",
  `--user-data-dir=${PROFILE}`,
  `${ORIGIN}/__mapinteraction.html`,
], { stdio: "ignore", detached: true });

const deadline = Date.now() + 120000;
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

// -webkit-touch-callout Safari/WebKit'e özgüdür; Blink onu ne hesaplanmış
// stilde ne de cssText'te tutar, yani hiçbir Chromium koşucusu doğrulayamaz.
// Bildirimin GERÇEKTEN sevk edildiğini kaynakta doğruluyoruz — iOS'ta uzun
// basışta seçim/callout balonunu engelleyen tek şey bu satır.
{
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const block = css.match(/\.map-container-inner\.is-mobile-map\s*\{[^}]*\}/);
  results.push({
    name: "çark/telefon: iOS touch-callout kapatması kaynakta sevk ediliyor",
    pass: !!block && /-webkit-touch-callout:\s*none/.test(block[0]),
    detail: block ? "is-mobile-map bloğunda" : "blok bulunamadı",
  });
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "  ok  " : "FAIL  "} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} assertion geçti`);
process.exit(failed === 0 ? 0 : 1);
