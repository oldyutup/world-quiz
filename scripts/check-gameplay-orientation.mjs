/**
 * check-gameplay-orientation — lifecycle guard for the Kuşatma landscape lock.
 *
 * The failure modes this protects against are all invisible until a player
 * hits them on a device:
 *   - the app stuck in landscape after leaving gameplay,
 *   - a duplicate lock taken and only released once (so it never unlocks),
 *   - a rejected lock stalling the queue so the *unlock* never runs either.
 *
 * `createOrientationLock` takes an injectable driver precisely so these can
 * be exercised here against a fake, with no device and no Capacitor bridge.
 *
 *   Run: node scripts/check-gameplay-orientation.mjs
 */

import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, "../src/lib/useGameplayOrientation.ts");

// Load the real module, but stub the two imports that need a browser/bridge.
// Only `createOrientationLock` is under test; it touches neither.
const src = readFileSync(srcPath, "utf8")
  .replace(/import\s*\{[^}]*\}\s*from\s*"react";?/, "")
  .replace(/import\s*\{[^}]*\}\s*from\s*"@capacitor\/core";?/,
           "const Capacitor = { isNativePlatform: () => false };")
  .replace(/import\s*\{[^}]*\}\s*from\s*"@capacitor\/screen-orientation";?/,
           "const ScreenOrientation = { lock: async () => {}, unlock: async () => {} };")
  .replace(/export function useGameplayOrientation[\s\S]*$/, "");

const js = transformSync(src, { loader: "ts", format: "esm" }).code;
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const { createOrientationLock } = mod;

const results = [];
const ok = (name, cond, detail) =>
  results.push({ name, pass: !!cond, detail: String(detail ?? "") });

/** Fake driver that records the call order and can be made slow or failing. */
function makeDriver({ lockDelay = 0, lockFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async lockLandscape() {
      calls.push("lock");
      if (lockDelay) await new Promise(r => setTimeout(r, lockDelay));
      if (lockFails) throw new Error("OS refused");
    },
    async unlock() {
      calls.push("unlock");
    },
  };
}

const settle = () => new Promise(r => setTimeout(r, 60));

// ── 1. gameplay mount locks landscape exactly once ───────────────────────────
{
  const d = makeDriver();
  const lock = createOrientationLock(d);
  await lock.acquire();
  await settle();
  ok("gameplay mount locks landscape",
     d.calls.join(",") === "lock", d.calls.join(","));
}

// ── 2. gameplay exit restores orientation ────────────────────────────────────
{
  const d = makeDriver();
  const lock = createOrientationLock(d);
  await lock.acquire();
  lock.release();
  await settle();
  ok("gameplay exit unlocks", d.calls.join(",") === "lock,unlock", d.calls.join(","));
  ok("no holders left after exit", lock.holders() === 0, lock.holders());
}

// ── 3. no duplicate lock while already held ──────────────────────────────────
{
  const d = makeDriver();
  const lock = createOrientationLock(d);
  await lock.acquire();
  await lock.acquire();          // e.g. a second consumer / re-render
  await settle();
  ok("second acquire does not re-lock",
     d.calls.filter(c => c === "lock").length === 1, d.calls.join(","));
  lock.release();
  await settle();
  ok("still held while one consumer remains",
     !d.calls.includes("unlock"), d.calls.join(","));
  lock.release();
  await settle();
  ok("unlocks once the last consumer leaves",
     d.calls.join(",") === "lock,unlock", d.calls.join(","));
}

// ── 4. leaving before the lock settles must still unlock ─────────────────────
// This is the "stuck in landscape" case: the player backs out of the match
// while the platform is still processing the rotation request.
{
  const d = makeDriver({ lockDelay: 120 });
  const lock = createOrientationLock(d);
  const p = lock.acquire();
  lock.release();                 // unmount mid-flight
  await p.catch(() => undefined);
  await new Promise(r => setTimeout(r, 220));
  ok("unlock lands after an in-flight lock (never stuck landscape)",
     d.calls.join(",") === "lock,unlock", d.calls.join(","));
}

// ── 5. a rejected lock neither throws nor stalls the unlock ──────────────────
{
  const d = makeDriver({ lockFails: true });
  const lock = createOrientationLock(d);
  let threw = false;
  try { await lock.acquire(); } catch { threw = true; }
  ok("a refused lock surfaces as a rejection the hook can catch", threw, threw);
  lock.release();
  await settle();
  ok("unlock still runs after a refused lock",
     d.calls.join(",") === "lock,unlock", d.calls.join(","));
}

// ── 6. StrictMode double-mount ends up locked, not unlocked ──────────────────
{
  const d = makeDriver();
  const lock = createOrientationLock(d);
  await lock.acquire(); lock.release();   // dev double-invoke
  await lock.acquire();
  await settle();
  ok("StrictMode remount ends locked",
     d.calls.join(",") === "lock,unlock,lock" && lock.holders() === 1,
     d.calls.join(",") + " holders=" + lock.holders());
}

// ── 7. structural: only the gameplay screen requests the lock ────────────────
{
  const consumers = [];
  const files = [
    "../src/modes/conquest/ConquestGame.tsx",
    "../src/modes/conquest/ConquestLobby.tsx",
    "../src/modes/conquest/ConquestSetup.tsx",
    "../src/modes/conquest/ConquestMode.tsx",
    "../src/App.tsx",
  ];
  for (const f of files) {
    const text = readFileSync(resolve(here, f), "utf8");
    if (text.includes("useGameplayOrientation(")) consumers.push(f.split("/").pop());
  }
  ok("only the gameplay screen locks orientation (lobby/setup/home do not)",
     consumers.length === 1 && consumers[0] === "ConquestGame.tsx",
     consumers.join(",") || "none");
}

// ── 8. structural: web never takes the native path ───────────────────────────
{
  const text = readFileSync(srcPath, "utf8");
  ok("web path is gated behind isNativePlatform()",
     /if\s*\(!native\)/.test(text) && /status:\s*"unsupported"/.test(text),
     "native gate present");
  // Strip comments first — the doc block legitimately *explains* why the raw
  // web API is not used, and matching prose would be a false positive.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("no raw screen.orientation.lock fallback left in the code path",
     !/screen\.orientation/.test(code), "clean");
  ok("uses the official @capacitor/screen-orientation plugin",
     /from\s+"@capacitor\/screen-orientation"/.test(code), "official plugin imported");
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "  ok  " : "FAIL  "} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
process.exit(failed === 0 ? 0 : 1);
