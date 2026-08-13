/**
 * check-conquest-map-viewport — behavioural guard for the Kuşatma mobile
 * map gestures (ConquestMapViewport).
 *
 * The rule this protects is the one that breaks gameplay when it regresses:
 * dragging or pinching the board must NEVER be read as a region selection,
 * while a short still tap must still select.  A silent regression here means
 * players lose turns to moves they did not intend to make, which no unit
 * test on the reducer would catch — the bug lives in pointer sequencing.
 *
 * Drives the real component (mounted by the dev harness at
 * /conquest-mobile-dev) with synthetic PointerEvents in headless Chrome and
 * asserts against the live transform plus a click counter the harness
 * exposes on `window.__cqTest.regionClicks`.
 *
 *   Prerequisite: a dev server on :5199  →  npx vite --port 5199
 *   Run:          node scripts/check-conquest-map-viewport.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN  = process.env.CQ_ORIGIN ?? "http://localhost:5199";
const PUBLIC  = new URL("../public/", import.meta.url).pathname;
const PORT    = 5212;
const PROFILE = mkdtempSync(join(tmpdir(), "cq-vp-"));

// The scenario runs inside the page. Kept as one string so the whole gesture
// sequence shares a clock and a pointer-id space.
const SCENARIO = `
async function run() {
  const out = [];
  const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail ?? "") });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const doc  = document.getElementById("f").contentDocument;
  const win  = document.getElementById("f").contentWindow;
  const vp    = doc.querySelector(".mcq-mapvp");
  const inner = doc.querySelector(".mcq-mapvp-inner");
  if (!vp || !inner) return [{ name: "mount", pass: false, detail: "viewport not found" }];

  win.__cqTest = win.__cqTest || { regionClicks: 0 };
  const clicks = () => win.__cqTest.regionClicks;
  const scale  = () => {
    const m = new win.DOMMatrixReadOnly(win.getComputedStyle(inner).transform);
    return { k: +m.a.toFixed(3), x: +m.e.toFixed(1), y: +m.f.toFixed(1) };
  };

  const box = vp.getBoundingClientRect();
  const cx  = box.left + box.width / 2;
  const cy  = box.top  + box.height / 2;

  function pe(type, id, x, y) {
    // pointerdown goes to the deepest element so the event travels the same
    // path a real touch would (region path -> ... -> .mcq-mapvp).  move/up
    // go straight to the viewport, which is what pointer capture does in a
    // real browser: once captured, every later event for that pointer id is
    // retargeted to the capturing element regardless of where the finger is.
    const target = type === "pointerdown" ? (doc.elementFromPoint(x, y) || vp) : vp;
    target.dispatchEvent(new win.PointerEvent(type, {
      pointerId: id, clientX: x, clientY: y,
      bubbles: true, cancelable: true, isPrimary: id === 1, pointerType: "touch",
    }));
  }
  function clickAt(x, y) {
    const target = doc.elementFromPoint(x, y) || vp;
    target.dispatchEvent(new win.MouseEvent("click", {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  }

  // ── 1. short still tap selects ───────────────────────────────────────────
  const before1 = clicks();
  pe("pointerdown", 1, cx, cy); await sleep(30);
  pe("pointerup",   1, cx, cy);
  clickAt(cx, cy); await sleep(30);
  ok("short tap selects a region", clicks() === before1 + 1,
     "clicks " + before1 + " -> " + clicks());
  ok("tap does not zoom", scale().k === 1, JSON.stringify(scale()));

  await sleep(420); // clear the double-tap window

  // ── 2. drag at fit scale must not select and must not pan ────────────────
  const before2 = clicks();
  pe("pointerdown", 2, cx, cy);
  for (let i = 1; i <= 6; i++) pe("pointermove", 2, cx - i * 12, cy - i * 5);
  pe("pointerup", 2, cx - 72, cy - 30);
  clickAt(cx - 72, cy - 30); await sleep(30);
  ok("drag never selects a region", clicks() === before2,
     "clicks " + before2 + " -> " + clicks());
  ok("drag at fit scale does not pan", scale().x === 0 && scale().y === 0,
     JSON.stringify(scale()));

  await sleep(420);

  // ── 3. pinch zooms in, and does not select ───────────────────────────────
  const before3 = clicks();
  pe("pointerdown", 10, cx - 40, cy);
  pe("pointerdown", 11, cx + 40, cy);
  for (let i = 1; i <= 5; i++) {
    pe("pointermove", 10, cx - 40 - i * 14, cy);
    pe("pointermove", 11, cx + 40 + i * 14, cy);
  }
  pe("pointerup", 10, cx - 110, cy);
  pe("pointerup", 11, cx + 110, cy);
  clickAt(cx, cy); await sleep(40);
  const afterPinch = scale();
  ok("pinch zooms in", afterPinch.k > 1.3, JSON.stringify(afterPinch));
  ok("pinch never selects a region", clicks() === before3,
     "clicks " + before3 + " -> " + clicks());

  // ── 4. panning while zoomed works, and is clamped ────────────────────────
  const before4 = clicks();
  pe("pointerdown", 3, cx, cy);
  for (let i = 1; i <= 8; i++) pe("pointermove", 3, cx + i * 30, cy + i * 14);
  pe("pointerup", 3, cx + 240, cy + 112);
  clickAt(cx + 240, cy + 112); await sleep(40);
  const panned = scale();
  ok("pan while zoomed does not select", clicks() === before4,
     "clicks " + before4 + " -> " + clicks());
  ok("pan clamped: board never leaves the frame (x<=0, y<=0)",
     panned.x <= 0.5 && panned.y <= 0.5, JSON.stringify(panned));

  // Drag hard the other way; the board must stop at its own edge, never
  // expose empty space on the right/bottom.
  pe("pointerdown", 4, cx, cy);
  for (let i = 1; i <= 14; i++) pe("pointermove", 4, cx - i * 60, cy - i * 30);
  pe("pointerup", 4, cx - 840, cy - 420);
  await sleep(40);
  const w = vp.clientWidth, h = vp.clientHeight;
  const p2 = scale();
  ok("pan clamped at the far edge too",
     p2.x >= w - w * p2.k - 0.5 && p2.y >= h - h * p2.k - 0.5,
     JSON.stringify(p2) + " frame " + w + "x" + h);

  // ── 5. fit-to-screen control restores the default view ───────────────────
  const reset = doc.querySelector(".mcq-mapvp-reset");
  ok("fit control appears once zoomed", !!reset, reset ? "present" : "missing");
  if (reset) {
    reset.click();
    await sleep(360);
    const r = scale();
    ok("fit control restores scale 1 at origin",
       r.k === 1 && r.x === 0 && r.y === 0, JSON.stringify(r));
  }

  await sleep(420);

  // ── 6. double-tap zooms and is not a selection ───────────────────────────
  // Double-tap TOGGLES, so this only means "zooms in" from the fit view.
  ok("board is back at fit before the double-tap case", scale().k === 1,
     JSON.stringify(scale()));
  const before6 = clicks();
  pe("pointerdown", 5, cx, cy); await sleep(20); pe("pointerup", 5, cx, cy);
  clickAt(cx, cy);
  await sleep(80);
  pe("pointerdown", 6, cx, cy); await sleep(20); pe("pointerup", 6, cx, cy);
  clickAt(cx, cy);
  await sleep(360);
  const dt = scale();
  ok("double-tap zooms in", dt.k > 1.5, JSON.stringify(dt));
  ok("double-tap costs at most the first tap's selection",
     clicks() - before6 <= 1, "clicks +" + (clicks() - before6));

  return out;
}
run().then(r => fetch("http://localhost:${PORT}/", {
  method: "POST", body: JSON.stringify(r),
})).catch(e => fetch("http://localhost:${PORT}/", {
  method: "POST", body: JSON.stringify([{ name: "scenario", pass: false, detail: e.message }]),
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

// 844x390 landscape: the viewport this feature exists for.
const wrapperPath = `${PUBLIC}__cqviewport.html`;
writeFileSync(wrapperPath, `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}
iframe{width:844px;height:390px;border:0;display:block}</style></head>
<body><iframe id="f" src="/conquest-mobile-dev?scene=action&measure=1"></iframe>
<script>setTimeout(function(){${SCENARIO}}, 2500);</script></body></html>`);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--window-size=900,720",
  `--user-data-dir=${PROFILE}`,
  `${ORIGIN}/__cqviewport.html`,
], { stdio: "ignore", detached: true });

const deadline = Date.now() + 30000;
while (inbox.length === 0 && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 300));
}
try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
try { execFileSync("pkill", ["-f", "headless"]); } catch { /* none running */ }
server.close();
try { unlinkSync(wrapperPath); } catch { /* already removed */ }

if (inbox.length === 0) {
  console.error("FAIL: no result from the page (is the dev server on " + ORIGIN + "?)");
  process.exit(1);
}

const results = JSON.parse(inbox[0]);
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "  ok  " : "FAIL  "} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
process.exit(failed === 0 ? 0 : 1);
