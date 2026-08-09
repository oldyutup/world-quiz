/**
 * check-guest-conversion-browser.mjs
 *
 * MİSAFİR → KAYITLI slot devrinin KISA tarayıcı testi (Kör Nokta lobisi).
 * 5 turluk maç OYNANMAZ; tek bir lobi durumu yeterlidir.
 *
 * NE KANITLIYOR
 * -------------
 *   1. Misafir oda koduyla giriyor  → satır MİSAFİR (profile_id null)
 *   2. Misafir UYGULAMA ÜZERİNDEN giriş yapıyor (auth-flip GERÇEK)
 *   3. AYNI player_id korunuyor      (yeni satır OLUŞMUYOR)
 *   4. profile_id dolmuş             (hesaba bağlandı)
 *   5. guest_id temizlenmiş          ← anon+claim_token artık odayı OKUYAMIYOR;
 *                                      bu, tevatur_authorize_player'ın misafir
 *                                      dalının (`guest_id is not null`) artık
 *                                      tutmadığının DAVRANIŞSAL kanıtıdır
 *   6. takım/skor/ad korunuyor
 *   7. refresh sonrası AYNI slot, KAYITLI kimlikle devam ediyor
 *
 * NEDEN İKİ HESAP: oda kurmak yalnız kayıtlı kullanıcıya açık (host = A) ve
 * misafirin devredeceği hesap host'tan FARKLI olmalı (aynı hesap olsaydı
 * sunucu doğru şekilde `already_in_room` derdi).
 *
 * GİZLİLİK: şifreler yalnız ortam değişkeninden okunur, ASLA loglanmaz.
 *
 * Çalıştır:
 *   TORBLE_A_EMAIL=... TORBLE_A_PASSWORD=... \
 *   TORBLE_B_EMAIL=... TORBLE_B_PASSWORD=... \
 *   node scripts/check-guest-conversion-browser.mjs
 *
 * Varsayılan hedef http://localhost:4173 (npm run build && npm run preview).
 * TORBLE_BASE_URL ile değiştirilebilir.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

/* ── Playwright: npx önbelleğinden, kurulum gerekmez; sistem Chrome kullanılır ── */
const require_ = createRequire(import.meta.url);
function loadPlaywright() {
  const { execSync } = require_("node:child_process");
  const roots = execSync("ls -d ~/.npm/_npx/*/node_modules/playwright 2>/dev/null || true", {
    shell: "/bin/zsh", encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  for (const r of roots) {
    try { return require_(r); } catch { /* sonrakini dene */ }
  }
  throw new Error("Playwright bulunamadı (npx önbelleği boş). `npx playwright@latest --version` bir kez çalıştır.");
}
const { chromium } = loadPlaywright();
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Test kimlikleri: önce ortam değişkeni, yoksa `.env.test.local`
 *  (`.gitignore`daki `.env.*.local` deseni kapsar → repoya ASLA girmez).
 *  Değerler hiçbir yerde loglanmaz. */
function testCreds() {
  const out = { ...process.env };
  const p = new URL("../.env.test.local", import.meta.url);
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 1 || line.trimStart().startsWith("#")) continue;
      const k = line.slice(0, i).trim();
      if (!out[k]) out[k] = line.slice(i + 1).trim();
    }
  }
  return out;
}
const CREDS = testCreds();

const BASE = CREDS.TORBLE_BASE_URL ?? "http://localhost:4173";
const A_EMAIL = CREDS.TORBLE_A_EMAIL;
const A_PASS  = CREDS.TORBLE_A_PASSWORD;
const B_EMAIL = CREDS.TORBLE_B_EMAIL;
const B_PASS  = CREDS.TORBLE_B_PASSWORD;

if (!A_EMAIL || !A_PASS || !B_EMAIL || !B_PASS) {
  console.error(
    "Test kimlikleri eksik. Repo kökünde .env.test.local oluştur:\n" +
    "  TORBLE_A_EMAIL=...\n  TORBLE_A_PASSWORD=...\n" +
    "  TORBLE_B_EMAIL=...\n  TORBLE_B_PASSWORD=..."
  );
  process.exit(2);
}

/* ── Supabase (yalnız PUBLIC anon anahtar; doğrulama sorguları için) ── */
function env() {
  const p = new URL("../.env", import.meta.url);
  if (!existsSync(p)) throw new Error(".env bulunamadı");
  const raw = readFileSync(p, "utf8");
  const get = (n) => raw.match(new RegExp(`^${n}=(.*)$`, "m"))?.[1]?.trim();
  return { url: get("VITE_SUPABASE_URL"), key: get("VITE_SUPABASE_ANON_KEY") };
}
const { url: SB_URL, key: SB_KEY } = env();

/** tevatur_get_room_state — istenirse bir kullanıcı JWT'siyle. */
async function roomState(roomId, playerId, claimToken, jwt) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/tevatur_get_room_state`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${jwt ?? SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_room_id: roomId, p_player_id: playerId, p_claim_token: claimToken }),
  });
  try { return await r.json(); } catch { return null; }
}

let passed = 0, failed = 0;
const ok = (cond, label, got) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Bir koşul sağlanana kadar bekle (sabit uzun uyku yerine). */
async function until(fn, { timeout = 20000, every = 500, label = "koşul" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Zaman aşımı: ${label}`);
    await sleep(every);
  }
}

const overlayOf = (page) => page.locator(".auth-overlay");

/** Misafire açılan "hoş geldin" auth modal'ını kapatır (varsa).
 *  Kapatmadan davet akışı çalışmaz: App, `authOpen` true iken misafir nick
 *  ekranına yönlendirme dalına GİRMEZ. */
async function dismissWelcome(page) {
  const overlay = overlayOf(page);
  if (!(await overlay.isVisible().catch(() => false))) return false;
  await overlay.locator('button:has-text("Misafir olarak devam et")').click();
  await overlay.waitFor({ state: "hidden", timeout: 15000 });
  return true;
}

/** Uygulamanın auth modal'ından e-posta+şifre ile giriş yapar.
 *  Modal zaten açıksa onu kullanır; değilse misafir oyun-sonu CTA'sının
 *  yaydığı GERÇEK olayı tetikler (GuestEndPrompt ile birebir aynı yol) —
 *  böylece 5 turluk maç oynamadan aynı giriş noktasına varılır. */
async function loginViaUi(page, email, password) {
  const overlay = overlayOf(page);
  if (!(await overlay.isVisible().catch(() => false))) {
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("torble:guest-signup"))
    );
    await overlay.waitFor({ state: "visible", timeout: 15000 });
  }
  // "Giriş" sekmesi varsayılan; yine de garantiye al.
  const loginTab = overlay.locator('button:text-is("Giriş")');
  if (await loginTab.isVisible().catch(() => false)) await loginTab.click();

  await overlay.locator('input[type="email"]').fill(email);
  await overlay.locator('input[type="password"]').fill(password);
  await overlay.locator('button:has-text("Giriş Yap")').last().click();
  await overlay.waitFor({ state: "hidden", timeout: 25000 });
}

async function main() {
  console.log(`\nHedef: ${BASE}\n`);
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });

  const ctxA = await browser.newContext();   // kayıtlı host
  const ctxB = await browser.newContext();   // misafir → sonra hesap B
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const p of [A, B]) {
    p.on("console", (m) => {
      const t = m.text();
      if (t.includes("[guestLink]")) console.log(`    ‹sayfa› ${t}`);
    });
  }

  try {
    /* ── 1) HOST: giriş + Kör Nokta odası kur ───────────────────────────── */
    console.log("1) Host (kayıtlı) odayı kuruyor");
    await A.goto(BASE, { waitUntil: "domcontentloaded" });
    await loginViaUi(A, A_EMAIL, A_PASS);
    await until(async () => await A.evaluate(() =>
      Object.keys(localStorage).some(k => k.startsWith("sb-") && k.includes("auth-token"))
    ), { label: "host girişi" });
    ok(true, "host giriş yaptı");

    // Kör Nokta kartındaki "Oyna" → seçim modalı → "Oda Kur" →
    // "kornokta-create" ekranı; oda MOUNT'ta otomatik kurulur.
    await A.locator(".mode-card", { hasText: "KÖR NOKTA" })
           .locator("button.mode-card-btn").click({ timeout: 20000 });
    await A.locator('button.modal-btn:has-text("Oda Kur")').click({ timeout: 15000 });

    const roomCode = await until(async () => await A.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("geoquiz_kornokta_room") ?? "{}").roomCode || null; }
      catch { return null; }
    }), { label: "oda kodu" });
    ok(!!roomCode, `oda kuruldu (kod: ${roomCode})`);

    /* ── 2) MİSAFİR: oda koduyla katıl ──────────────────────────────────── */
    console.log("\n2) Misafir odaya katılıyor");
    // Önce hoş geldin modal'ını kapat: açıkken davet dalı çalışmaz.
    await B.goto(BASE, { waitUntil: "domcontentloaded" });
    await dismissWelcome(B);
    await B.goto(`${BASE}/?korNokta=${roomCode}`, { waitUntil: "domcontentloaded" });

    const nick = `mis${Date.now() % 100000}`;
    const nickInput = B.locator("input.gj-input");
    await nickInput.waitFor({ state: "visible", timeout: 20000 });
    await nickInput.fill(nick);
    await B.locator('button:has-text("Misafir Olarak Katıl")').click();

    const sess = await until(async () => await B.evaluate(() => {
      try {
        const r = JSON.parse(localStorage.getItem("geoquiz_kornokta_room") ?? "{}");
        return r.playerId && r.claimToken ? r : null;
      } catch { return null; }
    }), { label: "misafir oda oturumu" });
    ok(!!sess.playerId && !!sess.claimToken, "misafir oturumu yazıldı (playerId + claimToken)");

    const before = await roomState(sess.roomId, sess.playerId, sess.claimToken);
    const meBefore = before?.players?.find(p => p.id === sess.playerId);
    ok(before?.ok === true, "misafir anon+claim_token ile oda durumunu OKUYABİLİYOR");
    ok(!!meBefore && meBefore.profile_id === null, "satır MİSAFİR (profile_id null)", meBefore?.profile_id);
    const countBefore = before?.players?.length ?? 0;
    const teamBefore  = meBefore?.team ?? null;
    const scoreBefore = meBefore?.score ?? null;
    const nameBefore  = meBefore?.name ?? null;
    console.log(`    oda: ${countBefore} oyuncu · ad="${nameBefore}" · takım=${teamBefore} · skor=${scoreBefore}`);

    /* ── 3) AUTH FLIP: misafir uygulama üzerinden B hesabına giriyor ────── */
    console.log("\n3) Misafir giriş yapıyor (auth-flip → uzlaştırma)");
    await loginViaUi(B, B_EMAIL, B_PASS);

    const bJwt = await until(async () => await B.evaluate(() => {
      const k = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.includes("auth-token"));
      if (!k) return null;
      try { return JSON.parse(localStorage.getItem(k)).access_token ?? null; } catch { return null; }
    }), { label: "misafir girişi" });
    ok(!!bJwt, "misafir hesabına giriş yapıldı");

    /* ── 4) DEVİR gerçekleşti mi? ───────────────────────────────────────── */
    console.log("\n4) Slot devri doğrulanıyor");
    const after = await until(async () => {
      const s = await roomState(sess.roomId, sess.playerId, sess.claimToken, bJwt);
      const me = s?.players?.find(p => p.id === sess.playerId);
      return me?.profile_id ? s : null;
    }, { timeout: 25000, label: "slot devri" });

    const meAfter = after.players.find(p => p.id === sess.playerId);
    ok(meAfter.id === sess.playerId, "AYNI player_id korundu");
    ok(!!meAfter.profile_id, "profile_id doldu", meAfter.profile_id);
    ok(after.players.length === countBefore, "YENİ satır oluşmadı (oyuncu sayısı aynı)", after.players.length);
    ok((meAfter.team ?? null) === teamBefore, "takım korundu", meAfter.team);
    ok((meAfter.score ?? null) === scoreBefore, "skor korundu", meAfter.score);

    // guest_id temizlendi mi? → anon + claim_token ARTIK okuyamamalı.
    const anonAfter = await roomState(sess.roomId, sess.playerId, sess.claimToken);
    ok(anonAfter?.ok === false,
       "guest_id temizlendi (anon+claim_token artık üye sayılmıyor)", anonAfter?.reason ?? anonAfter?.ok);

    /* ── 5) REFRESH: aynı slot, kayıtlı kimlikle ────────────────────────── */
    console.log("\n5) Refresh sonrası devamlılık");
    await B.reload({ waitUntil: "domcontentloaded" });
    await sleep(3000);
    const sess2 = await B.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("geoquiz_kornokta_room") ?? "{}"); }
      catch { return {}; }
    });
    ok(sess2.playerId === sess.playerId, "refresh sonrası AYNI player_id", sess2.playerId);

    const afterReload = await roomState(sess.roomId, sess.playerId, sess.claimToken, bJwt);
    const meReload = afterReload?.players?.find(p => p.id === sess.playerId);
    ok(afterReload?.ok === true && !!meReload?.profile_id,
       "refresh sonrası slot hâlâ KAYITLI kimlikle geçerli");
    ok(afterReload.players.length === countBefore, "refresh sonrası oyuncu sayısı hâlâ aynı");
  } catch (err) {
    failed++;
    console.log(`\n  ✗ HATA: ${err.message}`);
    for (const [n, p] of [["A", A], ["B", B]]) {
      await p.screenshot({ path: `/tmp/torble-conv-${n}.png` }).catch(() => {});
    }
    console.log("  (ekran görüntüleri: /tmp/torble-conv-A.png, /tmp/torble-conv-B.png)");
  } finally {
    await browser.close();
  }

  console.log(failed === 0 ? `\n✅ ${passed} geçti, 0 başarısız\n`
                           : `\n❌ ${passed} geçti, ${failed} BAŞARISIZ\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
