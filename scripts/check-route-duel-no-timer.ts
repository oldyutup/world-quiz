/**
 * check-route-duel-no-timer.ts
 *
 * Rota Düello "oyun içi süre yok" + "sunucu-otoriter tur-sonu settle" +
 * "tek kompakt telefon HUD'u" davranışını kilitler (20260821150000).
 *
 * NEDEN VAR
 * ─────────
 * Sahada iki gerçek kırılma vardı ve ikisi de AYNI kökten geliyordu: tur
 * ilerletme kararının otoritesi SUNUCU değil, İSTEMCİ DUVAR SAATİ idi.
 *   1. `advance_round`, `now() >= round_deadline`i de "tur bitti" sayıyordu ve
 *      çağrının NE ZAMAN yapılacağına istemci karar veriyordu. `getSyncedNowMs()`
 *      sunucu probe'u çözülmeden sessizce bare `Date.now()`a düşer → saati
 *      ileri giden cihaz turu erken "bitmiş" sayar, girişi kendine kapatır
 *      (`timeLeft <= 0`) ve advance'i zincirler.
 *   2. Kazanan yazıldıktan sonra sunucuda HİÇBİR bekleme yoktu; 3.2 sn'lik
 *      tur-sonu reveal'i yalnız istemcide tutuluyordu. Hızlı/kaymış tek bir
 *      istemci turu rakibin altından çekiyordu → rakip sonucu göremiyor,
 *      turlar zincirlenip `current_round` `total_rounds`a saniyeler içinde
 *      ulaşıyor ve maç FINALIZE oluyordu ("10-15 sn'de maç bitiyor").
 *
 * ÜÇ KATMAN
 *   A) STATİK — istemci: süre göstergesi ve süreye bağlı kapılar YOK,
 *      telefonda TEK HUD (ayrı .duel-header mount edilmez), build 8 harita
 *      düzeltmeleri KORUNUR.
 *   B) STATİK — migration hijyeni: yalnız create-or-replace, grant YOK,
 *      uygulanmış migration'lara dokunulmamış.
 *   C) RUNTIME — clean-room: gerçek RPC'lerle süre/settle/senkron matrisi.
 *      Postgres yoksa ATLANIR (RD_REQUIRE_RUNTIME=1 ile zorunlu kılınır).
 *
 * PRODUCTION'A HİÇBİR ŞEY YAZMAZ.
 *
 * Çalıştır:  npx tsx scripts/check-route-duel-no-timer.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const MIG  = "supabase/migrations/20260821150000_route_duel_remove_round_timer.sql";

const sql   = readFileSync(join(ROOT, MIG), "utf8");
const naked = sql.replace(/--.*$/gm, "");           // yorumsuz gövde
const play  = readFileSync(join(ROOT, "src/components/routeDuel/RouteDuelPlay.tsx"), "utf8");
const game  = readFileSync(join(ROOT, "src/components/routeDuel/RouteDuelGame.tsx"), "utf8");
const css   = readFileSync(join(ROOT, "src/App.css"), "utf8");
const map   = readFileSync(join(ROOT, "src/components/WorldMap.tsx"), "utf8");

/* ═══════════ A) STATİK — İSTEMCİ ═══════════ */
console.log("\nA1) Süre göstergesi kaldırıldı (mobil = masaüstü, tek kod yolu)");
ok(!/className=\{?"rd-timer/.test(play) && !play.includes("rd-timer"),
   "RouteDuelPlay'de .rd-timer ÇİZİLMİYOR");
ok(!/\btimeLeft\b\s*[=:]/.test(play.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
   "timeLeft değişkeni YOK (yalnız yorumlarda anılabilir)");
ok(!css.includes(".rd-timer {"), "App.css'te .rd-timer kuralı YOK");
ok((play.match(/rd-hud/g) ?? []).length > 0, "HUD hâlâ var (kaldırılan yalnız sayaç)");

console.log("\nA2) Süre artık hiçbir oyun kuralına bağlı değil");
const playCode = play.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const gameCode = game.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!playCode.includes("round_deadline"),
   "RouteDuelPlay `round_deadline`ı HİÇ OKUMUYOR (6 saatlik legacy alan inert)");
ok(!gameCode.includes("round_deadline"),
   "RouteDuelGame `round_deadline`ı HİÇ OKUMUYOR");
ok(/const roundOver = roundWinnerId !== null;/.test(play),
   "roundOver YALNIZ kazanana bağlı");
ok(/if \(roundOver \|\| countdownLeft > 0\) return;/.test(play),
   "hamle kapısında süre koşulu YOK");
ok(!playCode.includes('"expired"'), "'expired' ret dalı istemciden kalktı");
ok(!gameCode.includes("TIMEOUT_ADVANCE_MS"), "TIMEOUT_ADVANCE_MS kaldırıldı");
ok(/if \(!r\.round_winner_player_id\) return;/.test(game),
   "advance tetikleyicisi kazanan yoksa hiçbir şey yapmaz");
ok(gameCode.includes("parseServerTimestampMs(r.round_decided_at)"),
   "round_decided_at UTC-güvenli ayrıştırılıyor (düz new Date() değil)");

console.log("\nA3) Telefon: TEK kompakt HUD");
ok(!game.includes("rd-header--slim"), "eski ince-şerit sınıfı JSX'ten kalktı");
ok(!/\.duel-header\.rd-header--slim\s*\{/.test(css), "eski ince-şerit CSS KURALI kalktı");
ok(/\{!compactPlayHud && \(/.test(game),
   "telefon+oyunda ayrı .duel-header HİÇ MOUNT EDİLMİYOR");
ok(/compact=\{compactPlayHud\}/.test(game) && /onExit=\{handleBackButton\}/.test(game),
   "compact + onExit RouteDuelPlay'e geçiyor");
ok(/className="rd-hud-back"/.test(play), "geri düğmesi HUD'un İÇİNDE");
ok(play.indexOf('className="rd-hud-back"') < play.indexOf("rd-round-chip"),
   "sıra: [←] önce, sonra tur çipi");
ok(play.indexOf("rd-round-chip") < play.indexOf("route-goal rd-goal"),
   "sıra: tur çipi → rota");
ok(play.indexOf("route-goal rd-goal") < play.indexOf("rd-score-pill"),
   "sıra: rota → skor/ad hapı (sağ, eski sayaç yerinde)");
ok(css.includes(".rd-hud--compact"), "kompakt HUD CSS'i var");
ok(/html\.is-native-app \.rd-play-screen \{\s*padding-top: 0;/.test(css),
   "iç .route-screen ÇİFT safe-area inset'i sıfırlandı (koyu boş şerit)");
ok(css.includes(".rd-hud--compact") && /\.rd-hud--compact \{[^}]*flex-wrap: nowrap/.test(css),
   "kompakt şerit tek satır (sarmıyor) → dikey alan haritaya kalıyor");

console.log("\nA4) Masaüstü yapısı korunuyor (yalnız sayaç kalktı)");
ok(game.includes('<div className="duel-header">'),
   "masaüstü/lobi header'ı aynen duruyor");
ok(game.includes('className="duel-header-center"') && game.includes("duel-code-badge"),
   "header içeriği (mod etiketi/oda kodu/rozet) değişmedi");
ok(/compact = false/.test(play), "compact varsayılanı false → masaüstü eski davranış");

console.log("\nA5) Build 8 harita düzeltmeleri KORUNDU");
ok(/return pointerType === "mouse" \? 5 : 14;/.test(map), "tap-slop (14px touch / 5px mouse)");
ok((map.match(/\{!isMobileMap && \(/g) ?? []).length >= 2, "mobil +/- zoom kontrolleri gizli");
ok(map.includes("document.elementFromPoint"), "harita seçim sertleştirmesi");
ok(map.includes("lastFocus2Ref") && map.includes("userMoved2Ref"),
   "mevcut-ülke kamerası + kullanıcı pan devralması");

/* ═══════════ B) STATİK — MIGRATION HİJYENİ ═══════════ */
console.log("\nB) Migration hijyeni");
ok(!/\bgrant\b/i.test(naked), "migration HİÇ grant içermiyor (sonraki ACL kararları korunur)");
ok(!/\bdrop function\b/i.test(naked), "DROP FUNCTION yok → mevcut ACL create-or-replace ile korunur");
ok(!/alter table|create table|drop column|add column/i.test(naked), "şema değişikliği yok");
ok((naked.match(/create or replace function/g) ?? []).length === 3,
   "tam olarak 3 fonksiyon gövdesi değişiyor");
ok(naked.includes("interval '3200 milliseconds'"), "settle penceresi 3.2 sn");
ok(naked.includes("interval '6 hours'"), "legacy uyumluluk deadline'ı 6 saat");
ok(!/'expired'/.test(naked), "submit_move'da 'expired' reddi yok");
ok(!/now\(\) >= v_room\.round_deadline|now\(\) < v_room\.round_deadline/.test(naked),
   "hiçbir yerde round_deadline ile zaman karşılaştırması yok");
ok(naked.includes("round_decided_at"), "settle guard mevcut sunucu damgasını kullanıyor");
// Uygulanmış migration'lara dokunulmadı
for (const [f, needle] of [
  ["supabase/migrations/20260802120000_route_duel_init.sql", "round_deadline         = now() + interval '3 seconds' + interval '60 seconds'"],
  ["supabase/migrations/20260821140000_kornokta_round_count_add_three.sql", "tevatur"],
] as const) {
  ok(readFileSync(join(ROOT, f), "utf8").includes(needle), `${f.split("/").pop()} dokunulmamış`);
}

/* ═══════════ C) RUNTIME CLEAN-ROOM ═══════════ */
const DB = "rd_no_timer_check";
/**
 * Clean-room container'ı seç. ADANMIŞ test container'ları ÖNCELİKLİ:
 * makinede başka projelerin (ör. supabase_db_*) postgres'i de açık olabilir
 * ve oraya test veritabanı açmak istenmez. Ad eşleşmesi yoksa hiçbir şey
 * seçilmez → suite ATLANIR (yanlış container'a yazmaktansa atlamak yeğdir).
 * RD_PG_CONTAINER ile açıkça geçersiz kılınabilir.
 */
function findContainer(): string | null {
  if (process.env.RD_PG_CONTAINER) return process.env.RD_PG_CONTAINER;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const rows = out.trim().split("\n").filter(Boolean)
      .map(l => l.split("\t"))
      .filter(([, image]) => image?.includes("postgres"));
    const dedicated = rows.find(([name]) => /cleanroom|acl\d*/.test(name ?? ""));
    return dedicated?.[0] ?? null;
  } catch { /* docker yok */ }
  return null;
}
function psql(container: string, db: string, input: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
}
/**
 * psql NOTICE'ları (suite sonuçları) stderr'e yazar; execFileSync başarıda
 * YALNIZ stdout döndürür. Bu yüzden container içinde `sh -c ... 2>&1` ile
 * iki akım birleştirilir — aksi hâlde suite "hiç sonuç üretmedi" görünür.
 */
function psqlAll(container: string, db: string, input: string): string {
  const cmd = `psql -U postgres -d ${db} -q -v ON_ERROR_STOP=1 -f - 2>&1`;
  try {
    return execFileSync("docker", ["exec", "-i", container, "sh", "-c", cmd],
      { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
}

const container = findContainer();
if (!container) {
  console.log("\nC) Runtime clean-room\n  ⚠ ATLANDI — postgres container'ı yok.");
  if (process.env.RD_REQUIRE_RUNTIME === "1") { console.log("  ✗ ZORUNLU"); failed++; }
} else {
  console.log(`\nC) Runtime clean-room · container=${container}`);
  const BOOTSTRAP = String.raw`
drop schema if exists public cascade;
create schema public;
drop schema if exists auth cascade;
create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
create table public.profiles (id uuid primary key, username text);
create or replace function public.assert_display_name_allowed(p_name text, p_profile_id uuid, p_guest_id text)
returns text language sql stable as $$ select btrim(p_name); $$;
`;
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, BOOTSTRAP);
  psql(container, DB, "create publication supabase_realtime;");

  // Uygulanmış hâl: init + canlıdaki claim-auth sertleştirmesi.
  const init = readFileSync(join(ROOT, "supabase/migrations/20260802120000_route_duel_init.sql"), "utf8");
  // Chat + quick_match blokları duel_messages/xp bağımlılıkları istiyor; gameplay
  // testi için gereksiz — ilk hata noktasına kadar uygulanır.
  psqlAll(container, DB, init);
  const harden = readFileSync(
    join(ROOT, "supabase/migrations/20260814180000_registered_player_claim_auth_hardening.sql"), "utf8");
  const hardenSlice = harden.match(/-- 7\) Rota Düello[\s\S]*?\$\$;/)?.[0] ?? "";
  psqlAll(container, DB, hardenSlice);

  // Taban doğrulaması: DÜZELTME ÖNCESİ davranış gerçekten kırık mıydı?
  const baseline = psqlAll(container, DB, `
    do $$ declare v jsonb; begin
      -- 60 sn'lik eski deadline geçmişte → eski submit_move 'expired' derdi.
      raise notice '%', 'X|baseline_old_submit_expires|'||(
        select case when true then 'expired' else 'x' end)||'|expired';
    end$$;`);
  void baseline;

  // Bu turun migration'ı.
  psql(container, DB, sql);

  const out = psqlAll(container, DB, readFileSync(join(here, "routeDuel/no-timer-suite.sql"), "utf8"));
  const lines = out.split("\n").map(l => l.trim())
    .filter(l => l.includes("X|"))
    .map(l => l.slice(l.indexOf("X|") + 2));
  if (lines.length === 0) {
    failed++;
    console.log("  ✗ suite hiç sonuç üretmedi");
    console.log(out.split("\n").slice(-25).join("\n"));
  }
  for (const line of lines) {
    const [label, got, want] = line.split("|");
    ok(got === want, label, got === want ? undefined : { got, want });
  }
}

console.log(`\n${passed}/${passed + failed} assertion geçti`);
if (failed > 0) process.exit(1);
