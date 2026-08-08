/**
 * check-room-context-effect.ts
 *
 * "Oda içi sosyal bağlam" effect'inin SÖZLEŞMESİNİ saf/DB'siz doğrular.
 * Gerçek Supabase ve tarayıcı GEREKMEZ.
 *
 * NEDEN VAR
 * ─────────
 * Yedi online modun hepsinde aynı effect vardı:
 *
 *   const social = useSocialOptional();
 *   useEffect(() => {
 *     if (!social) return;
 *     if (code) social.setRoomContext({ ... });   // HER SEFERİNDE yeni nesne
 *     return () => social.setRoomContext(null);
 *   }, [social, code]);                           // ← tüm context nesnesi
 *
 * SocialContext'teki `value` useMemo'sunun bağımlılıkları arasında
 * `roomContext` vardır. Zincir şöyle kapanıyordu:
 *
 *   setRoomContext(obj) → roomContext değişti → value useMemo yeniden
 *   → `social` yeni identity → effect deps değişti → cleanup setRoomContext(null)
 *   → roomContext değişti → … (React 50 iç içe güncellemede
 *     "Maximum update depth exceeded" ile keser)
 *
 * DÜZELTME: effect tüm `social` nesnesine değil, YALNIZ stable
 * `setRoomContext` setter'ına bağlanır. Bu bir `useState` setter'ı olduğu
 * için React kimliğini garanti eder; `roomContext` değişse de effect
 * yeniden tetiklenmez, döngü kapanır.
 *
 * DRIFT UYARISI: bu dosya yedi modun KAYNAK METNİNİ denetler. Yeni bir online
 * mod eklenirse MODE_FILES listesine eklenmelidir.
 *
 * Çalıştır:  npx tsx scripts/check-room-context-effect.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

/** Oda bağlamı kuran TÜM online modlar + beklenen mode anahtarı. */
const MODE_FILES: ReadonlyArray<[file: string, modeKey: string]> = [
  ["src/modes/korNokta/KorNoktaMode.tsx",        "korNokta"],
  ["src/modes/conquest/ConquestLobby.tsx",       "conquest"],
  ["src/components/DuelGame.tsx",                "duel"],
  ["src/components/FlagDuelGame.tsx",            "flagDuel"],
  ["src/components/WheelDuelGame.tsx",           "wheelDuel"],
  ["src/components/WheelGroupGame.tsx",          "wheelGroup"],
  ["src/components/routeDuel/RouteDuelGame.tsx", "routeDuel"],
];

/* ════════════════════════════════════════════════════════════════════════
   1) Setter GERÇEKTEN stable mi? (fix'in dayandığı varsayım)
   ════════════════════════════════════════════════════════════════════════
   setRoomContext ham bir useState setter'ı olmalı ve context value'suna
   OLDUĞU GİBİ konmalı. Biri onu useCallback/wrapper ardına alırsa stabilite
   varsayımı sessizce çöker ve döngü geri gelebilir. */
console.log("\n1) setRoomContext stable bir useState setter'ı mı?");

const ctx = read("src/components/SocialContext.tsx");

ok(
  /const\s*\[\s*roomContext\s*,\s*setRoomContext\s*\]\s*=\s*useState/.test(ctx),
  "setRoomContext doğrudan useState'ten geliyor (React kimliği garanti eder)",
);
ok(
  !/setRoomContext\s*=\s*useCallback/.test(ctx) &&
  !/const\s+setRoomContext\s*=\s*\(/.test(ctx),
  "setRoomContext bir wrapper/useCallback ardına ALINMAMIŞ",
);
// Provider value'su içinde kısayol olarak (shorthand) taşınmalı; yeniden
// tanımlanırsa referans her render değişir.
ok(
  /^\s*setRoomContext,\s*$/m.test(ctx),
  "context value'suna shorthand olarak konuyor (yeniden sarılmıyor)",
);
// Döngünün DİĞER ucu: roomContext value useMemo'sunun bağımlılığıdır.
// Bu hâlâ doğruysa, effect'in tüm nesneye bağlanması yine döngü kurar —
// yani aşağıdaki 2. bölüm kuralı gevşetilemez.
ok(
  /const\s+value\s*=\s*useMemo/.test(ctx),
  "context value useMemo ile üretiliyor",
);

/* ════════════════════════════════════════════════════════════════════════
   2) ANA DEĞİŞMEZ — hiçbir mod tüm `social` nesnesine bağlanmaz
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Effect bağımlılıkları (yedi online mod)");

for (const [file, modeKey] of MODE_FILES) {
  const src = read(file);
  const name = file.split("/").pop();

  // Effect gövdesini setRoomContext(null) cleanup'ının etrafından çıkar.
  const anchor = src.indexOf("setRoomContext(null)");
  ok(anchor > 0, `${name}: oda bağlamı effect'i bulundu`);
  if (anchor < 0) continue;
  const deps = src.slice(anchor, anchor + 200).match(/\}, \[([^\]]*)\]\)/)?.[1] ?? "";

  // (a) Tüm context nesnesi bağımlılık OLAMAZ — kök neden buydu.
  ok(
    !/(^|[^A-Za-z.])social([^A-Za-z]|$)/.test(deps),
    `${name}: bağımlılıklarda tüm \`social\` nesnesi YOK`,
    deps.trim(),
  );
  // (b) Stable setter bağımlılık OLMALI (körlemesine silinmiş olmamalı).
  ok(
    deps.includes("setRoomContext"),
    `${name}: stable setter bağımlılıkta duruyor`,
    deps.trim(),
  );
  // (c) Oda kodu bağımlılık OLMALI — kod değişince bağlam yenilenmeli.
  ok(
    /room\?\.code|roomCode/.test(deps),
    `${name}: oda kodu bağımlılıkta duruyor`,
    deps.trim(),
  );
  // (d) ESLint susturulmamış olmalı (kuralı kapatmak bu fix'i saklardı).
  const around = src.slice(Math.max(0, anchor - 400), anchor + 200);
  ok(
    !around.includes("eslint-disable") || !around.includes("react-hooks/exhaustive-deps"),
    `${name}: exhaustive-deps susturulmamış`,
  );
  // (e) Setter stable binding üzerinden çağrılmalı, nesne üzerinden değil.
  ok(
    !src.includes("social.setRoomContext"),
    `${name}: setter \`social.\` üzerinden ÇAĞRILMIYOR`,
  );
  // (f) Davranış korunuyor: doğru mode anahtarı + roomUrl hâlâ kuruluyor.
  ok(
    src.includes(`mode: "${modeKey}"`) && src.includes(`/?${modeKey}=`),
    `${name}: mode="${modeKey}" ve roomUrl bağlamı korunuyor`,
  );
  // (g) Cleanup hâlâ var — unmount/oda değişiminde bağlam temizlenmeli.
  ok(
    /return \(\) => setRoomContext\(null\)/.test(src),
    `${name}: unmount/oda değişimi cleanup'ı korunuyor`,
  );
}

/* ════════════════════════════════════════════════════════════════════════
   3) Kapsam — yeni bir online mod sessizce listeden kaçmasın
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Kapsam denetimi");

// Depoda setRoomContext çağıran her dosya ya SocialContext'in kendisi ya da
// yukarıdaki listede olmalı. Aksi hâlde yeni bir mod denetlenmeden eklenmiştir.
import { execSync } from "node:child_process";
const hits = execSync(
  `grep -rl "setRoomContext" "${join(here, "..", "src")}" || true`,
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .map((p) => p.replace(join(here, "..") + "/", ""))
  .filter((p) => !p.endsWith("SocialContext.tsx"))
  .sort();

const known = MODE_FILES.map(([f]) => f).sort();
ok(
  JSON.stringify(hits) === JSON.stringify(known),
  "setRoomContext çağıran dosya kümesi denetlenen listeyle birebir aynı",
  hits,
);

/* ──────────────────────────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
