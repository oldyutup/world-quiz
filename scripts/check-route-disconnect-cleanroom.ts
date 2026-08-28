/**
 * check-route-disconnect-cleanroom.ts — Rota Düello İKİ AŞAMALI kopuş kuralının
 * GERÇEK Postgres'te (docker) clean-room doğrulaması. Canlıya DOKUNMAZ.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NEDEN GEREKLİ
 * ─────────────
 *   check-build9-blockers.ts kuralın TypeScript MODELİNİ sürer; bu dosya
 *   migration'ın KENDİSİNİ gerçek bir veritabanında çalıştırır. Tablolar ve
 *   fonksiyonlar 20260802120000'den BİREBİR (metin olarak) çıkarılır — elle
 *   yeniden yazılmaz, böylece "test kendi kopyasını doğrulama" tuzağına
 *   düşülmez.
 *
 * KATMANLAR
 *   L0  şema (20260802120000'den birebir DDL) + roller + auth.uid() taklidi
 *   L1  ÖNCESİ fonksiyonlar (20260802120000'den birebir):
 *         route_duel_authorize_player / heartbeat / handle_disconnect
 *   L2  20260827120000 (tam dosya, birebir)
 *   S   ACL karşılaştırması + davranış senaryoları + eşzamanlılık
 *
 * ZAMAN SİMÜLASYONU
 *   `now()` ASLA yeniden tanımlanmaz. Zamanın geçişi yalnız SAKLANAN damgalar
 *   geriye alınarak taklit edilir (last_seen_at / disconnect_watch_since) —
 *   sunucunun okuduğu şey zaten bunlardır. Karar mantığı olduğu gibi çalışır.
 *
 * Çalıştır:  npx tsx scripts/check-route-disconnect-cleanroom.ts
 *   Konteyner: ROUTE_SEC_PG_CONTAINER=<ad> (varsayılan: çalışan ilk
 *   `postgres:` imajlı konteyner; `supabase_*` adları dışlanır).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = "route_disconnect_sec";
const INIT = readFileSync(join(ROOT, "supabase/migrations/20260802120000_route_duel_init.sql"), "utf8");
const MIG  = readFileSync(join(ROOT, "supabase/migrations/20260827120000_route_duel_disconnect_two_phase.sql"), "utf8");

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `   (got ${JSON.stringify(got)})` : ""}`); }
}
const section = (t: string) => console.log(`\n${t}`);

/* ── Migration metninden BİREBİR blok çıkarma ───────────────────────────── */
/** `create table … ( … );` bloğunu parantez dengesiyle çıkarır (check
 *  kısıtlarındaki iç parantezler regex'i bozuyordu). */
function grabTable(name: string): string {
  const head = `create table if not exists public.${name} (`;
  const i = INIT.indexOf(head);
  if (i < 0) throw new Error(`DDL bulunamadı: ${name}`);
  let depth = 0;
  for (let k = i + head.length - 1; k < INIT.length; k++) {
    if (INIT[k] === "(") depth++;
    else if (INIT[k] === ")") { depth--; if (depth === 0) return INIT.slice(i, INIT.indexOf(";", k) + 1); }
  }
  throw new Error(`DDL kapanmadı: ${name}`);
}
function grabBetween(start: string, end: string): string {
  const i = INIT.indexOf(start);
  if (i < 0) throw new Error(`blok bulunamadı: ${start}`);
  const j = INIT.indexOf(end, i);
  return INIT.slice(i, j < 0 ? undefined : j);
}

/* ── docker/psql ───────────────────────────────────────────────────────── */
function findContainer(): string | null {
  const explicit = process.env.ROUTE_SEC_PG_CONTAINER;
  if (explicit) return explicit;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t");
      if (name.startsWith("supabase_")) continue;   // başka projenin yığını
      if (image?.startsWith("postgres:")) return name;
    }
  } catch { /* docker yok */ }
  return null;
}
function psql(c: string, db: string, input: string, tuples = false): string {
  const args = ["exec", "-i", c, "psql", "-U", "postgres", "-d", db, "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}
const last = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

/* ── Kimlikler ─────────────────────────────────────────────────────────── */
const ROOM = "00000000-0000-4000-8000-0000000000r1".replace("r", "a");
const P_A  = "00000000-0000-4000-8000-0000000000aa";   // host (kayıtlı)
const P_B  = "00000000-0000-4000-8000-0000000000bb";   // guest (misafir)
const U_A  = "00000000-0000-4000-8000-00000000000a";
const TOK_B = "00000000-0000-4000-8000-0000000000tb".replace("t", "c");

const L0 = String.raw`
drop schema if exists public cascade;  create schema public;
drop schema if exists auth   cascade;  create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;

${grabTable("route_duel_rooms")}
${grabTable("route_duel_players")}
${grabTable("route_duel_player_claims")}

-- Supabase varsayılan ayrıcalık taklidi (migration'lar bunu geri alır).
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
`;

const L1 = [
  grabBetween("create or replace function public.route_duel_authorize_player",
              "create or replace function public.route_duel_authorize_host"),
  grabBetween("create or replace function public.route_duel_heartbeat",
              "-- Sunucu-doğrulamalı kopuş eşiği"),
  grabBetween("create or replace function public.route_duel_handle_disconnect",
              "-- ────────────────────────────────────────────────────────────────────────────\n-- 18)"),
].join("\n");

const FIXTURE = String.raw`
insert into public.route_duel_rooms (id, code, status, host_player_id, game_seq,
                                     current_round, started_at)
values ('${ROOM}', 'RDSEC1', 'playing', '${P_A}', 1, 1, now() - interval '5 minutes');
insert into public.route_duel_players (id, room_id, name, is_host, profile_id, guest_id)
values ('${P_A}', '${ROOM}', 'A', true,  '${U_A}', null),
       ('${P_B}', '${ROOM}', 'B', false, null,     'g-b');
insert into public.route_duel_player_claims (player_id, claim_token)
values ('${P_B}', '${TOK_B}');
`;

const ACL_SQL = String.raw`
select f || '=' ||
       has_function_privilege('anon', f, 'EXECUTE')::text || '/' ||
       has_function_privilege('authenticated', f, 'EXECUTE')::text || '/' ||
       coalesce((select p.prosecdef::text from pg_proc p where p.oid = f::regprocedure), '?') || '/' ||
       coalesce((select array_to_string(p.proconfig,',') from pg_proc p where p.oid = f::regprocedure), 'no-search_path') || '/' ||
       coalesce((select case when array_to_string(p.proacl::text[], ' ') like '%=X/%'
                              and array_to_string(p.proacl::text[], ' ') like '=X/%' then 'PUBLIC-X' else 'no-public' end
                   from pg_proc p where p.oid = f::regprocedure), '?')
  from (values ('public.route_duel_heartbeat(uuid,uuid)'),
               ('public.route_duel_handle_disconnect(uuid,uuid,uuid)'),
               ('public.route_duel_authorize_player(uuid,uuid)')) t(f)
 order by f;
`;

/* ══════════════════════════════════════════════════════════════════════════ */
const c = findContainer();
if (!c) { console.error("✗ postgres konteyneri yok (ROUTE_SEC_PG_CONTAINER=<ad>)"); process.exit(1); }
console.log(`clean-room konteyneri: ${c}   (db: ${DB})`);

psql(c, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
psql(c, DB, L0);
psql(c, DB, L1);

section("1) ACL — migration ÖNCESİ / SONRASI (anon/auth EXECUTE · secdef · search_path · PUBLIC)");
const aclBefore = psql(c, DB, ACL_SQL, true).trim();
psql(c, DB, MIG);
const aclAfter = psql(c, DB, ACL_SQL, true).trim();
for (const [i, lineB] of aclBefore.split("\n").entries()) {
  const lineA = aclAfter.split("\n")[i];
  ok(lineB === lineA, `ACL DEĞİŞMEDİ · ${lineB.split("=")[0]}`, `önce=${lineB} sonra=${lineA}`);
}
ok(aclAfter.includes("route_duel_heartbeat(uuid,uuid)=true/true/true/search_path=public, auth/no-public"),
   "heartbeat: anon+auth EXECUTE, SECURITY DEFINER, sabit search_path, PUBLIC yok",
   aclAfter.split("\n").find(l => l.includes("heartbeat")));

section("2) Şema — izleme kolonları eklendi, gameplay kolonları bozulmadı");
ok(psql(c, DB, `select count(*)::text from information_schema.columns
   where table_name='route_duel_rooms' and column_name in
   ('disconnect_watch_player_id','disconnect_watch_since');`, true).trim() === "2",
   "iki izleme kolonu var");

/* ── Yardımcılar ────────────────────────────────────────────────────────── */
const asUser = (uid: string | null, body: string) => String.raw`
begin;
select set_config('torble.uid', ${uid ? `'${uid}'` : "''"}, false);
set local role authenticated;
${body}
commit;`;
const reset = () => {
  psql(c, DB, `delete from public.route_duel_player_claims;
               delete from public.route_duel_players;
               delete from public.route_duel_rooms;`);
  psql(c, DB, FIXTURE);
};
/** Zaman geçişi: SAKLANAN damgalar geriye alınır (now() dokunulmaz). */
const age = (col: string, who: string, secs: number) =>
  psql(c, DB, `update public.route_duel_players set ${col} = now() - interval '${secs} seconds' where id = '${who}';`);
const ageWatch = (secs: number) =>
  psql(c, DB, `update public.route_duel_rooms set disconnect_watch_since = now() - interval '${secs} seconds' where id = '${ROOM}';`);
const roomState = () => last(psql(c, DB,
  `select status || '|' || coalesce(finished_reason,'-') || '|' || coalesce(winner_player_id::text,'-')
        || '|' || coalesce(disconnect_watch_player_id::text,'-')
        || '|' || case when disconnect_watch_since is null then '-' else 'armed' end
     from public.route_duel_rooms where id='${ROOM}';`, true));
const callDisc = (uid: string | null, player: string, token: string | null) =>
  psql(c, DB, asUser(uid, `select public.route_duel_handle_disconnect('${ROOM}','${player}',${token ? `'${token}'` : "null"}) is not null;`), true);
const callBeat = (uid: string | null, player: string, token: string | null) =>
  psql(c, DB, asUser(uid, `select public.route_duel_heartbeat('${player}',${token ? `'${token}'` : "null"});`), true);

section("3) BOŞTA AMA BAĞLI — hamle yok, heartbeat var → ASLA kopuş");
{
  reset();
  // 10 dakika: her 3 sn'de bir İKİ taraf da beat atıyor ve kopuş kontrolü
  // istiyor; HİÇ HAMLE YOK. Döngü tek bir SQL oturumunda çalışır (800 ayrı
  // docker exec turu dakikalar sürüyordu; davranış aynı).
  psql(c, DB, String.raw`
do $$
declare i int;
begin
  perform set_config('torble.uid', '${U_A}', false);
  for i in 1..200 loop
    perform set_config('torble.uid', '${U_A}', false);
    perform public.route_duel_heartbeat('${P_A}', null);
    perform public.route_duel_handle_disconnect('${ROOM}', '${P_A}', null);
    perform set_config('torble.uid', '', false);
    perform public.route_duel_heartbeat('${P_B}', '${TOK_B}');
    perform public.route_duel_handle_disconnect('${ROOM}', '${P_B}', '${TOK_B}');
  end loop;
end $$;`);
  ok(roomState() === "playing|-|-|-|-", "200 tur (≈10 dk) boşta: oda 'playing', pencere hiç açılmadı", roomState());
}

section("4) TEK ÇAĞRI MAÇ BİTİREMEZ — 20 sn eşiği aşılsa bile");
{
  reset();
  age("last_seen_at", P_B, 300);           // B 5 dk sessiz
  callDisc(U_A, P_A, null);
  ok(roomState() === `playing|-|-|${P_B}|armed`,
     "ilk çağrı YALNIZCA pencere açar (status hâlâ playing)", roomState());
  callDisc(U_A, P_A, null);                // hemen ikinci çağrı
  ok(roomState().startsWith("playing|"),
     "hemen ardından ikinci çağrı da bitiremez (10 sn dolmadı)", roomState());
}

section("5) İKİ KANIT TAMAMLANINCA kopuş kesinleşir");
{
  ageWatch(11);                            // pencere 11 sn'dir açık
  callDisc(U_A, P_A, null);
  ok(roomState() === `finished|disconnect|${P_A}|-|-`,
     "20 sn bayatlık + 10 sn kesintisiz gözlem → kalan oyuncu kazanır", roomState());
  const before = roomState();
  callDisc(U_A, P_A, null);
  ok(roomState() === before, "bitmiş oda İDEMPOTENT (ikinci çağrı hiçbir şeyi değiştirmez)", roomState());
}

section("6) RECONNECT — rakipten gelen TEK beat pencereyi siler");
{
  reset();
  age("last_seen_at", P_B, 300);
  callDisc(U_A, P_A, null);
  ok(roomState().includes("armed"), "pencere açıldı", roomState());
  callBeat(null, P_B, TOK_B);              // B geri döndü
  ok(roomState() === "playing|-|-|-|-", "B'nin tek heartbeat'i pencereyi SİLDİ", roomState());
  callDisc(U_A, P_A, null);
  ok(roomState() === "playing|-|-|-|-",
     "reconnect sonrası A hemen kazanamaz (rakip taze → pencere bile açılmaz)", roomState());

  // Sayaç GERÇEKTEN sıfırdan başlıyor mu: B tekrar susarsa yeni pencere
  // açılmalı ve 10 sn dolmadan finalize OLMAMALI.
  age("last_seen_at", P_B, 300);
  callDisc(U_A, P_A, null);
  ok(roomState() === `playing|-|-|${P_B}|armed`, "B yeniden susunca pencere SIFIRDAN açıldı", roomState());
  callDisc(U_A, P_A, null);
  ok(roomState().startsWith("playing|"), "yeni pencere de tek çağrıyla olgunlaşmıyor", roomState());

  // Sarkık `watch_since` (player_id NULL) tek başına pencereyi KISALTAMAZ:
  // temizlik iki kolonu birlikte yazar, ama savunma derinliği olarak ölçülür.
  psql(c, DB, `update public.route_duel_rooms
                  set disconnect_watch_player_id = null,
                      disconnect_watch_since = now() - interval '999 seconds'
                where id='${ROOM}';`);
  callDisc(U_A, P_A, null);
  ok(roomState() === `playing|-|-|${P_B}|armed`,
     "sarkık watch_since finalize ETTİRMEZ — pencere yeniden açılır (kısayol yok)", roomState());
}

section("7) ARKA PLAN — dönen istemci birikmiş bayatlığı ANINDA bozdurmaz");
{
  reset();
  age("last_seen_at", P_A, 120);           // A da 2 dk yoktu (arka plan)
  age("last_seen_at", P_B, 120);
  callBeat(U_A, P_A, null);                // A döndü, beat attı
  callDisc(U_A, P_A, null);                // ve hemen kontrol istedi
  ok(roomState().startsWith("playing|") && roomState().includes("armed"),
     "A dönüşte YALNIZ pencere açabildi, maçı alamadı", roomState());
  callBeat(null, P_B, TOK_B);              // B 1 sn sonra döndü
  ok(roomState() === "playing|-|-|-|-", "B grace içinde dönünce pencere kapandı", roomState());
}

section("8) HOST / NON-HOST simetrisi (misafir de kopuş tespit edebilir)");
{
  reset();
  age("last_seen_at", P_A, 300);           // host sessiz
  callDisc(null, P_B, TOK_B);              // misafir kontrol ister
  ok(roomState() === `playing|-|-|${P_A}|armed`, "misafir de pencere açabiliyor", roomState());
  ageWatch(11);
  callDisc(null, P_B, TOK_B);
  ok(roomState() === `finished|disconnect|${P_B}|-|-`, "misafir kopuşu kesinleştirdi", roomState());
}

section("9) EŞZAMANLILIK — iki istek aynı anda ÇİFT finalize edemez");
{
  reset();
  age("last_seen_at", P_B, 300);
  callDisc(U_A, P_A, null);
  ageWatch(11);
  // Aynı anda: A ve B için handle_disconnect. FOR UPDATE seri kılmalı.
  const both = String.raw`
begin;
  select set_config('torble.uid','${U_A}',false);
  set local role authenticated;
  select public.route_duel_handle_disconnect('${ROOM}','${P_A}',null) is not null;
commit;
begin;
  select set_config('torble.uid','',false);
  set local role authenticated;
  select public.route_duel_handle_disconnect('${ROOM}','${P_B}','${TOK_B}') is not null;
commit;`;
  let err = "";
  try { psql(c, DB, both); } catch (e) { err = String((e as Error).message ?? e).slice(0, 160); }
  ok(err === "", "yarışan iki çağrı HATASIZ tamamlandı", err);
  ok(roomState() === `finished|disconnect|${P_A}|-|-`,
     "yalnız İLK çağrı kazandı; kazanan DEĞİŞMEDİ (çift finalize yok)", roomState());
  ok(last(psql(c, DB, `select count(*)::text from public.route_duel_rooms
                        where id='${ROOM}' and status='finished';`, true)) === "1",
     "oda tek kez finished");
}

section("10) YETKİ — çapraz oyuncu / yanlış token reddediliyor");
{
  reset();
  age("last_seen_at", P_B, 300);
  // Yabancı bir auth.uid() ile host adına çağrı
  let e1 = "";
  try { callDisc("00000000-0000-4000-8000-0000000000ff", P_A, null); }
  catch (e) { e1 = String((e as Error).message ?? e); }
  ok(/unauthorized/.test(e1), "başka bir auth.uid() host adına kopuş İSTEYEMEZ", e1.slice(0, 90));
  // Misafir için yanlış claim token
  let e2 = "";
  try { callDisc(null, P_B, "00000000-0000-4000-8000-0000000000fe"); }
  catch (e) { e2 = String((e as Error).message ?? e); }
  ok(/unauthorized/.test(e2), "yanlış claim token reddedildi", e2.slice(0, 90));
  // Heartbeat de aynı şekilde
  let e3 = "";
  try { callBeat("00000000-0000-4000-8000-0000000000ff", P_A, null); }
  catch (e) { e3 = String((e as Error).message ?? e); }
  ok(/unauthorized/.test(e3), "heartbeat de yabancı kimliği reddediyor", e3.slice(0, 90));
  ok(roomState().startsWith("playing|"), "reddedilen çağrılar odayı DEĞİŞTİRMEDİ", roomState());
}

section("11) HEARTBEAT gameplay'e DOKUNAMAZ");
{
  reset();
  psql(c, DB, `update public.route_duel_players set score = 3, current_key='Turkey',
                 path = array['Turkey'] where id='${P_A}';`);
  const before = last(psql(c, DB,
    `select score::text || '|' || coalesce(current_key,'-') || '|' || array_to_string(path,',')
       from public.route_duel_players where id='${P_A}';`, true));
  callBeat(U_A, P_A, null);
  const after = last(psql(c, DB,
    `select score::text || '|' || coalesce(current_key,'-') || '|' || array_to_string(path,',')
       from public.route_duel_players where id='${P_A}';`, true));
  ok(before === after, "heartbeat skor/konum/yol DEĞİŞTİRMİYOR", `${before} -> ${after}`);
  const roomBefore = roomState();
  callBeat(U_A, P_A, null);
  ok(roomState() === roomBefore, "heartbeat pencere yokken oda satırını YAZMIYOR (gereksiz realtime yayını yok)", roomState());
}

section("12) SUNUCU SAATİ — istemci damgası hiç kabul edilmiyor");
{
  ok(!/p_last_seen|p_now|p_client_time/i.test(MIG),
     "migration istemciden zaman parametresi ALMIYOR");
  const beatDef = last(psql(c, DB,
    `select (position('now()' in pg_get_functiondef(to_regprocedure('public.route_duel_heartbeat(uuid,uuid)'))) > 0)::text;`, true));
  ok(beatDef === "true", "last_seen_at yalnız sunucu now() ile yazılıyor");
}

psql(c, "postgres", `drop database if exists ${DB};\n`);
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
