/**
 * check-award-hardening.ts
 *
 * T-01 / T-02 / T-03 / T-04 pre-final güvenlik düzeltmelerinin sözleşmesini
 * kilitler.
 *
 * NEDEN VAR
 * ─────────
 * 2026-08-19 denetiminde dört reachable MEDIUM bulundu:
 *   T-01  `chat-<roomCode>` PUBLIC bir Realtime konusu ve LobbyChat gelen
 *         broadcast payload'ını doğrulamasız render ediyordu → istediğin
 *         `player_name` ile mesaj enjekte edilebiliyor, DB'ye satır
 *         yazılmadığı için antispam/moderasyon/rapor yolu atlanıyordu.
 *   T-02  `conquest-lobby:<roomId>` PUBLIC; snapshot/mode_change dışarıdan
 *         ezilebiliyordu ve bonusDistribution başlayan maça giriyordu.
 *   T-03  `award_gameplay_gold` blanket 500 cap dışında hiçbir frene sahip
 *         değildi → sınırsız gold.
 *   T-04  Tüm `award_*_xp_event` RPC'leri `p_room_id`'yi doğrulamıyordu →
 *         rastgele UUID ile sınırsız XP.
 *
 * ⚠ `private: true` BİR ÇÖZÜM DEĞİLDİR: `private` bayrağını istemci seçer;
 *   canlı probe'da anon istemci aynı konulara `private:false` ile katılıp
 *   `status=ok` aldı. Bu yüzden T-01/T-02 fix'i "kanalı kapatmak" değil,
 *   "payload'a güvenmemek"tir. Bu dosya o ilkenin geri açılmamasını korur.
 *
 * İKİ KATMAN
 * ──────────
 *   A) STATİK — bağımlılıksız. İstemci fix'lerinin ve migration
 *      gövdelerinin VARLIĞI + kapsam koruması.
 *   B) RUNTIME — gerçek Postgres'te clean-room. İki migration VERBATIM
 *      uygulanır ve exploit + meşru akışlar gerçekten çalıştırılır.
 *      Postgres yoksa katman ATLANIR (uyarıyla).
 *      Zorunlu kılmak için: AWARD_HARDENING_REQUIRE_RUNTIME=1
 *
 * Postgres keşfi: çalışan ilk `postgres*` imajlı docker container.
 * Elle seçmek için: AWARD_HARDENING_PG_CONTAINER=<container adı>
 *
 * Çalıştır:  npx tsx scripts/check-award-hardening.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Yorumları soyar — assertion'lar kendi açıklama metnimizle eşleşmesin. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "");
}

/**
 * jsonb ANAHTAR SIRASINI KORUMAZ (önce uzunluk, sonra alfabetik sıralar), bu
 * yüzden yanıt gövdesi sıraya duyarlı regex ile test EDİLMEZ; her parça
 * bağımsız aranır.
 */
function hasAll(text: string, ...parts: (string | RegExp)[]): boolean {
  return parts.every(p =>
    typeof p === "string" ? text.includes(p) : p.test(text));
}

/** jsonb yanıtında { "ok": true } var mı? */
function isOkTrue(text: string): boolean { return text.includes('"ok": true'); }

/** jsonb yanıtında belirli bir hata kodu var mı? */
function isCode(code: string, text: string): boolean {
  return text.includes('"ok": false') && text.includes(`"${code}"`);
}

/* ════════════════════════════════════════════════════════════════════════
   A) STATİK KATMAN
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n── A) STATİK ──────────────────────────────────────────────");

/* ── T-01: LobbyChat broadcast alıcısı kaldırıldı ─────────────────────── */
{
  const src = read("src/components/LobbyChat.tsx");

  ok(
    !/\.on\(\s*["']broadcast["']\s*,\s*\{\s*event:\s*["']msg["']/.test(src),
    "T-01: LobbyChat'te broadcast 'msg' ALICISI yok (spoof edilen payload render edilmiyor)",
  );
  ok(
    /\.on\(\s*\n?\s*["']postgres_changes["']/.test(src) &&
      /table:\s*["']duel_messages["']/.test(src),
    "T-01: postgres_changes INSERT aboneliği KORUNDU (server-otoriter teslim yolu)",
  );
  ok(
    /channelRef\.current\?\.send\(/.test(src),
    "T-01: broadcast GÖNDERİMİ korundu (eski App Store istemcisiyle interop)",
  );
  ok(
    /from\("duel_messages"\)\s*\n?\s*\.select/.test(src),
    "T-01: ilk DB geçmişi yüklemesi korundu",
  );
  // Sender identity server-side: her yaşayan mod RPC modunda olmalı.
  ok(
    /p_message:\s*text/.test(src) && !/player_name:\s*myName[\s\S]{0,200}rpc\(/.test(src),
    "T-01: RPC yolu player_name'i istemciden GÖNDERMİYOR (sunucuda türetiliyor)",
  );
}

/* ── T-02: conquest lobi broadcast kapıları ───────────────────────────── */
{
  const bc = read("src/modes/conquest/conquestLobbyBroadcast.ts");
  const mode = read("src/modes/conquest/ConquestMode.tsx");

  ok(
    /event:\s*["']snapshot["'][\s\S]{0,320}?if\s*\(isHost\)\s*return;/.test(bc),
    "T-02: snapshot HOST'ta yok sayılıyor (host lobi state'inin sahibi)",
  );
  ok(
    /event:\s*["']mode_change["'][\s\S]{0,320}?if\s*\(isHost\)\s*return;/.test(bc),
    "T-02: mode_change HOST'ta yok sayılıyor (maça giren ayar dışarıdan çevrilemez)",
  );
  for (const ev of ["vote_toggle", "clear_votes", "ready_for_next"]) {
    ok(
      new RegExp(`event:\\s*["']${ev}["'][\\s\\S]{0,320}?knownPlayer\\(`).test(bc),
      `T-02: ${ev} playerId bilinen oyuncu listesine karşı doğrulanıyor`,
    );
  }
  ok(
    /isKnownPlayer\?:\s*\(playerId: string\) => boolean/.test(bc),
    "T-02: isKnownPlayer doğrulayıcısı SubscribeArgs'ta tanımlı",
  );
  ok(
    /isKnownPlayer:\s*\(playerId\)\s*=>\s*\n?\s*playerRowsRef\.current\.some/.test(mode),
    "T-02: ConquestMode doğrulayıcıyı DB oyuncu listesinden besliyor",
  );
  ok(
    /const playerRowsRef\s*=\s*useRef/.test(mode) &&
      /playerRowsRef\.current = playerRows/.test(mode),
    "T-02: playerRowsRef stale-closure'a karşı senkron tutuluyor",
  );
  // Private kanala geçilmediğini doğrula (sahte fix koruması).
  // Yorumlar soyulur: bu dosyanın kendi açıklaması "private: true" içeriyor.
  const bcCode = stripComments(bc);
  ok(
    !/private:\s*true/.test(bcCode),
    "T-02: lobi kanalı private:true'ya ÇEVRİLMEDİ (sahte fix değil, payload güveni azaltıldı)",
  );
  // Oyun/skor state'ine dokunulmadı.
  ok(
    !/territor|gameplay_state|\bscore\b/i.test(bcCode),
    "T-02: lobi yardımcısı oyun/territory/skor state'ine dokunmuyor",
  );
}

/* ── T-03: gold migration gövdesi ─────────────────────────────────────── */
const GOLD_MIG = "supabase/migrations/20260819120000_gold_award_budget_hardening.sql";
{
  const sql = read(GOLD_MIG);

  const caps: Record<string, number> = {
    map_match_reward: 400,
    silhouette_match_reward: 1600,
    flag_match_reward: 25,
    route_match_reward: 40,
    conquest_liman_income: 5,
    conquest_fate_card_refund: 200,
    gameplay_award: 100,
  };
  for (const [reason, cap] of Object.entries(caps)) {
    ok(
      new RegExp(`when\\s+'${reason}'\\s+then\\s+${cap}\\b`).test(sql),
      `T-03: ${reason} per-call cap = ${cap}`,
    );
  }
  ok(
    /v_daily_cap\s+int\s*:=\s*3000;/.test(sql),
    "T-03: UTC günlük bütçe = 3000",
  );
  ok(
    /perform 1 from public\.profiles where id = v_uid for update;/.test(sql),
    "T-03: bütçe sayımından ÖNCE profil satırı kilitleniyor (TOCTOU kapalı)",
  );
  ok(
    /and source\s*=\s*'gameplay'/.test(sql) && /and reason\s*=\s*any\(v_allowed\)/.test(sql),
    "T-03: bütçe YALNIZ bu RPC'nin reason'larını sayıyor (daily_bonus/quest/achievement hariç)",
  );
  ok(
    /and amount\s*>\s*0/.test(sql),
    "T-03: harcamalar (negatif amount) bütçeye dahil değil",
  );
  ok(
    /'code',\s*'daily_cap_reached'/.test(sql),
    "T-03: limit yanıtı daily_cap_reached",
  );
  ok(
    /'code',\s*'amount_exceeds_cap'/.test(sql),
    "T-03: mevcut amount_exceeds_cap kod adı korundu (eski istemci sözleşmesi)",
  );
  ok(
    !/v_max\s+int\s*:=\s*500/.test(sql),
    "T-03: blanket 500 cap KALDIRILDI",
  );
  ok(
    /revoke execute on function public\.award_gameplay_gold\(int, text, jsonb\) from anon;/.test(sql) &&
      /grant\s+execute on function public\.award_gameplay_gold\(int, text, jsonb\) to authenticated;/.test(sql),
    "T-03: anon EXECUTE revoke, authenticated korunuyor",
  );
  ok(
    /create or replace function public\.award_gameplay_gold\(\s*\n\s*p_amount\s+int,\s*\n\s*p_reason\s+text,\s*\n\s*p_metadata jsonb/.test(sql),
    "T-03: imza (int, text, jsonb) DEĞİŞMEDİ",
  );
  ok(
    /set search_path = public/.test(sql) && /security definer/.test(sql),
    "T-03: SECURITY DEFINER + search_path korundu",
  );
  ok(
    !/alter table|drop function|create policy|enable row level/i.test(sql),
    "T-03: kapsam koruması — şema/politika/RLS değişikliği yok",
  );
}

/* ── T-04: XP migration gövdesi ───────────────────────────────────────── */
const XP_MIG = "supabase/migrations/20260819130000_xp_award_participation_hardening.sql";
{
  const sql = read(XP_MIG);

  const matrix: Record<string, string> = {
    country_duel: "duel_players",
    flag_duel: "duel_players",
    wheel_duel: "wheel_duel_players",
    group_country: "duel_group_players",
    route_duel: "route_duel_players",
    wheel_group: "wheel_group_players",
    conquest: "conquest_players",
    kornokta: "tevatur_players",
  };
  for (const [mode, table] of Object.entries(matrix)) {
    ok(
      new RegExp(`'${mode}'[\\s\\S]{0,240}?public\\.${table}`).test(sql),
      `T-04 matris: ${mode} → ${table}`,
    );
  }
  ok(
    /p_mode_key in \('country_duel', 'flag_duel'\)/.test(sql),
    "T-04: flag_duel, Ülke Yaz ile AYNI duel_players tablosunu paylaşıyor",
  );
  for (const rpc of [
    "award_xp_event",
    "award_conquest_xp_event",
    "award_wheel_group_xp_event",
    "award_kornokta_xp_event",
  ]) {
    ok(
      new RegExp(`create or replace function public\\.${rpc}\\(`).test(sql),
      `T-04: ${rpc} yeniden tanımlandı`,
    );
    ok(
      new RegExp(`${rpc}[\\s\\S]*?_xp_is_room_participant`).test(sql),
      `T-04: ${rpc} katılım kapısını çağırıyor`,
    );
  }
  ok(
    (sql.match(/'not_a_participant'/g) ?? []).length >= 4,
    "T-04: dört RPC de not_a_participant döndürüyor (throw değil — sözleşme korunuyor)",
  );
  ok(
    (sql.match(/on conflict \(profile_id, mode_key, room_id\) do nothing/g) ?? []).length >= 4,
    "T-04: mevcut idempotency KORUNDU",
  );
  ok(
    (sql.match(/least\(500,/g) ?? []).length >= 4,
    "T-04: clamp [0,500] korundu",
  );
  ok(
    /'photo_duel'[\s\S]{0,400}unsupported_mode|v_verifiable/.test(sql),
    "T-04: doğrulanamayan ölü anahtarlar (photo_duel/city_duel) reddediliyor",
  );
  ok(
    /revoke execute on function public\.award_harita_duel_xp_event\(uuid, uuid, int, text, jsonb\) from authenticated;/.test(sql),
    "T-04/T-05: award_harita_duel_xp_event authenticated'dan da revoke edildi",
  );
  ok(
    /award_harita_duel_xp_event[\s\S]*?'unsupported_mode'/.test(sql),
    "T-04/T-05: harita_duel gövdesi her koşulda awarded:false (ikinci katman)",
  );
  ok(
    /T-04 DURDU/.test(sql) && /pg_get_functiondef/.test(sql),
    "T-04: canlı award_xp_event sözleşme kapısı + rollback yedeği var",
  );
  for (const rpc of [
    "award_xp_event\\(uuid, text, uuid, int, text, jsonb\\)",
    "award_conquest_xp_event\\(uuid, uuid, int, text, jsonb\\)",
    "award_wheel_group_xp_event\\(uuid, uuid, int, text, jsonb\\)",
    "award_kornokta_xp_event\\(uuid, uuid, int, text, jsonb\\)",
  ]) {
    ok(
      new RegExp(`revoke execute on function public\\.${rpc} from anon;`).test(sql),
      `T-04: anon EXECUTE revoke — ${rpc.split("\\(")[0]}`,
    );
    ok(
      new RegExp(`grant\\s+execute on function public\\.${rpc} to authenticated;`).test(sql),
      `T-04: authenticated EXECUTE korundu — ${rpc.split("\\(")[0]}`,
    );
  }
  ok(
    !/alter table|drop table|create policy|enable row level/i.test(sql),
    "T-04: kapsam koruması — şema/politika/RLS değişikliği yok",
  );
}

/* ════════════════════════════════════════════════════════════════════════
   B) RUNTIME KATMAN — gerçek Postgres clean-room
   ════════════════════════════════════════════════════════════════════════ */

function findContainer(): string | null {
  const forced = process.env.AWARD_HARDENING_PG_CONTAINER;
  if (forced) return forced;
  try {
    const out = execFileSync(
      "docker",
      ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8" },
    );
    for (const line of out.split("\n")) {
      const [name, image] = line.split("\t");
      if (name && image && /postgres/i.test(image)) return name;
    }
  } catch {
    /* docker yok */
  }
  return null;
}

function psql(container: string, db: string, input: string, tuples = false): string {
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db,
                "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
}

const DB = "torble_award_hardening_check";

/** Canlı şemanın minimal ama sadık taklidi. */
const SCHEMA = String.raw`
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;

-- Supabase auth.uid() taklidi (GUC'tan okur).
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (
  id uuid primary key,
  gold int not null default 0,
  updated_at timestamptz not null default now()
);

create table public.gold_transactions (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  amount        int  not null,
  balance_after int  not null check (balance_after >= 0),
  reason        text not null,
  source        text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index on public.gold_transactions (profile_id, reason, created_at desc);

create table public.xp_events (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  mode_key   text not null,
  room_id    uuid not null,
  xp_earned  int  not null,
  result     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index xp_events_uniq on public.xp_events (profile_id, mode_key, room_id);

-- Yedi üyelik tablosu (yalnız matris için gereken kolonlar).
create table public.duel_players        (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.duel_group_players  (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.wheel_duel_players  (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.wheel_group_players (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.route_duel_players  (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.conquest_players    (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid, guest_id uuid);
create table public.tevatur_players     (id uuid primary key default gen_random_uuid(), room_id uuid not null, profile_id uuid not null);

-- _apply_gold_delta (canlı gövde ile birebir).
create or replace function public._apply_gold_delta(
  p_uid uuid, p_delta int, p_reason text, p_source text, p_metadata jsonb
) returns int language plpgsql security definer set search_path = public as $fn$
declare v_cur int; v_new int;
begin
  if p_uid is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  if p_delta is null or p_delta = 0 then raise exception 'invalid_amount' using errcode='22023'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'reason_required' using errcode='22023'; end if;
  select coalesce(gold,0) into v_cur from public.profiles where id = p_uid for update;
  if not found then raise exception 'no_profile' using errcode='02000'; end if;
  if p_delta < 0 and v_cur + p_delta < 0 then raise exception 'insufficient_gold' using errcode='23514'; end if;
  v_new := greatest(0, v_cur + p_delta);
  update public.profiles set gold = v_new, updated_at = now() where id = p_uid;
  insert into public.gold_transactions (profile_id, amount, balance_after, reason, source, metadata)
  values (p_uid, p_delta, v_new, p_reason, p_source, coalesce(p_metadata,'{}'::jsonb));
  return v_new;
end $fn$;
revoke all on function public._apply_gold_delta(uuid,int,text,text,jsonb) from public, anon, authenticated;

-- Sertleştirme ÖNCESİ award_gameplay_gold (blanket 500) — migration bunu ezecek.
create or replace function public.award_gameplay_gold(
  p_amount int, p_reason text, p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid(); v_max int := 500; v_new int;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if p_amount > v_max then return jsonb_build_object('ok',false,'code','amount_exceeds_cap','cap',v_max); end if;
  v_new := public._apply_gold_delta(v_uid,p_amount,p_reason,'gameplay',coalesce(p_metadata,'{}'::jsonb));
  return jsonb_build_object('ok',true,'gold',v_new,'amount',p_amount);
end $fn$;
grant execute on function public.award_gameplay_gold(int,text,jsonb) to anon, authenticated;

-- Sertleştirme ÖNCESİ award_xp_event — T-04 sözleşme kapısının GEÇMESİ için
-- precheck'in bildirdiği tüm mode_key'leri ve "on conflict" ifadesini taşımalı.
create or replace function public.award_xp_event(
  p_profile_id uuid, p_mode_key text, p_room_id uuid,
  p_xp_earned int, p_result text, p_details jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid(); v_allowed text[] := array[
  'country_duel','flag_duel','group_country','route_duel','photo_duel','city_duel','wheel_duel'];
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if v_uid <> p_profile_id then raise exception 'profile_id_mismatch'; end if;
  if not (p_mode_key = any(v_allowed)) then raise exception 'invalid_mode_key'; end if;
  insert into public.xp_events (profile_id, mode_key, room_id, xp_earned, result, details)
  values (p_profile_id, p_mode_key, p_room_id, greatest(0,least(500,p_xp_earned)), p_result, p_details)
  on conflict (profile_id, mode_key, room_id) do nothing;
  return jsonb_build_object('awarded',true,'reason',null,'xp_earned',p_xp_earned,'total_xp',0,'mode_xp',0);
end $fn$;
grant execute on function public.award_xp_event(uuid,text,uuid,int,text,jsonb) to anon, authenticated;

-- Sertleştirme ÖNCESİ adanmış RPC'ler (imza doğrulaması + revoke hedefi için).
create or replace function public.award_conquest_xp_event(p_profile_id uuid,p_room_id uuid,p_xp_earned int,p_result text,p_details jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = public as $$ select '{}'::jsonb $$;
create or replace function public.award_wheel_group_xp_event(p_profile_id uuid,p_room_id uuid,p_xp_earned int,p_result text,p_details jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = public as $$ select '{}'::jsonb $$;
create or replace function public.award_kornokta_xp_event(p_profile_id uuid,p_room_id uuid,p_xp_earned int,p_result text,p_details jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = public as $$ select '{}'::jsonb $$;
create or replace function public.award_harita_duel_xp_event(p_profile_id uuid,p_room_id uuid,p_xp_earned int,p_result text,p_details jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = public as $$ select '{}'::jsonb $$;
grant execute on function public.award_conquest_xp_event(uuid,uuid,int,text,jsonb)    to anon, authenticated;
grant execute on function public.award_wheel_group_xp_event(uuid,uuid,int,text,jsonb) to anon, authenticated;
grant execute on function public.award_kornokta_xp_event(uuid,uuid,int,text,jsonb)    to anon, authenticated;
grant execute on function public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb) to anon, authenticated;
`;

const container = findContainer();

if (!container) {
  const msg = "RUNTIME katmanı ATLANDI — çalışan postgres container'ı bulunamadı.";
  if (process.env.AWARD_HARDENING_REQUIRE_RUNTIME === "1") {
    console.error(`\n✗ ${msg} (AWARD_HARDENING_REQUIRE_RUNTIME=1)`);
    process.exit(1);
  }
  console.warn(`\n⚠ ${msg}`);
} else {
  console.log(`\n── B) RUNTIME (container: ${container}) ───────────────────`);

  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `drop database if exists ${DB}`], { stdio: "ignore" });
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `create database ${DB}`], { stdio: "ignore" });

  psql(container, DB, SCHEMA);

  // İki migration VERBATIM uygulanır — doğrulama DO blokları dahil.
  psql(container, DB, read(GOLD_MIG));
  ok(true, "RUNTIME: T-03 migration'ı temiz odada uygulandı (kendi DO doğrulaması geçti)");
  psql(container, DB, read(XP_MIG));
  ok(true, "RUNTIME: T-04 migration'ı temiz odada uygulandı (sözleşme kapısı + DO doğrulaması geçti)");

  // İdempotency: ikinci kez uygulanabilmeli.
  psql(container, DB, read(GOLD_MIG));
  psql(container, DB, read(XP_MIG));
  ok(true, "RUNTIME: her iki migration da İDEMPOTENT (ikinci uygulama sorunsuz)");

  const q = (sql: string) => psql(container, DB, sql, true).trim();

  /* ── T-03 runtime ──────────────────────────────────────────────────── */
  const UID = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  q(`insert into public.profiles (id) values ('${UID}'), ('${OTHER}');`);

  const gold = (uid: string | null, amount: number, reason: string) =>
    q(`${uid ? `set local torble.uid = '${uid}';` : `set local torble.uid = '';`}
       select public.award_gameplay_gold(${amount}, '${reason}')::text;`);

  ok(
    isCode('unauthenticated',q(
      `begin; set local torble.uid = ''; select public.award_gameplay_gold(10,'gameplay_award')::text; rollback;`)),
    "T-03 runtime: unauth reddedildi",
  );

  // Çapraz kullanıcı yapısal olarak imkânsız — imzada profil parametresi YOK.
  ok(
    q(`select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='award_gameplay_gold'
          and pg_get_function_identity_arguments(p.oid)='p_amount integer, p_reason text, p_metadata jsonb';`) === "1",
    "T-03 runtime: imza değişmedi ve hedef profil parametresi YOK (çapraz kullanıcı imkânsız)",
  );

  ok(
    isOkTrue(q(`begin; set local torble.uid='${UID}';
      select public.award_gameplay_gold(25,'flag_match_reward')::text; commit;`)),
    "T-03 runtime: meşru ödül (flag 25) yazıldı",
  );

  ok(
    hasAll(q(`begin; set local torble.uid='${UID}';
      select public.award_gameplay_gold(500,'conquest_liman_income')::text; rollback;`),
      '"amount_exceeds_cap"', '"cap": 5'),
    "T-03 runtime: küçük reason'da 500 reddedildi (cap=5)",
  );
  ok(
    hasAll(q(`begin; set local torble.uid='${UID}';
      select public.award_gameplay_gold(101,'gameplay_award')::text; rollback;`),
      '"amount_exceeds_cap"', '"cap": 100'),
    "T-03 runtime: gameplay_award 101 reddedildi (cap=100)",
  );
  ok(
    isCode('invalid_reason',q(`begin; set local torble.uid='${UID}';
      select public.award_gameplay_gold(10,'totally_made_up')::text; rollback;`)),
    "T-03 runtime: whitelist dışı reason reddedildi",
  );

  // Bütçe: 1600'lük silüet ödülü meşru → iki tanesi bütçe içinde kalmalı.
  q(`set torble.uid='${UID}'; select public.award_gameplay_gold(1600,'silhouette_match_reward');`);
  ok(
    isOkTrue(q(`set torble.uid='${UID}';
      select public.award_gameplay_gold(1300,'silhouette_match_reward')::text;`)),
    "T-03 runtime: bütçe ALTINDA meşru büyük ödül geçiyor (25+1600+1300 ≤ 3000)",
  );
  ok(
    isCode('daily_cap_reached',q(`set torble.uid='${UID}';
      select public.award_gameplay_gold(100,'gameplay_award')::text;`)),
    "T-03 runtime: bütçe ÜSTÜ reddedildi (daily_cap_reached)",
  );

  // Döngü ile aşma denemesi — toplam asla 3000'i geçemez.
  q(`set torble.uid='${UID}';
     do $$ begin for i in 1..40 loop perform public.award_gameplay_gold(100,'gameplay_award'); end loop; end $$;`);
  const total = Number(q(`select coalesce(sum(amount),0)::text from public.gold_transactions
    where profile_id='${UID}' and amount>0 and source='gameplay';`));
  ok(total <= 3000, `T-03 runtime: 40 çağrılık farming döngüsü bütçeyi AŞAMADI (toplam=${total} ≤ 3000)`);

  // gameplay DIŞI ekonomi bütçeye girmemeli.
  q(`insert into public.gold_transactions (profile_id,amount,balance_after,reason,source)
     values ('${OTHER}',50,50,'daily_bonus','daily'),
            ('${OTHER}',50,100,'daily_quest_reward','daily_quest'),
            ('${OTHER}',2900,3000,'achievement_reward','gameplay');`);
  ok(
    isOkTrue(q(`set torble.uid='${OTHER}';
      select public.award_gameplay_gold(100,'gameplay_award')::text;`)),
    "T-03 runtime: daily_bonus / daily_quest / achievement_reward bütçeye DAHİL DEĞİL",
  );

  // Eski istemci sözleşmesi.
  const okShape = q(`set torble.uid='${OTHER}'; select public.award_gameplay_gold(5,'conquest_liman_income')::text;`);
  ok(
    isOkTrue(okShape) && /"gold"/.test(okShape) && /"amount"/.test(okShape),
    "T-03 runtime: başarı yanıtı { ok, gold, amount } sözleşmesini koruyor",
  );

  ok(
    q(`select has_function_privilege('anon','public.award_gameplay_gold(int,text,jsonb)','EXECUTE')::text;`) === "false" &&
    q(`select has_function_privilege('authenticated','public.award_gameplay_gold(int,text,jsonb)','EXECUTE')::text;`) === "true",
    "T-03 runtime: anon EXECUTE kapalı, authenticated açık",
  );

  /* ── T-04 runtime ──────────────────────────────────────────────────── */
  const ROOM = "33333333-3333-3333-3333-333333333333";
  const FAKE = "99999999-9999-9999-9999-999999999999";
  q(`insert into public.duel_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.conquest_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.wheel_group_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.tevatur_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.wheel_duel_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.duel_group_players (room_id, profile_id) values ('${ROOM}','${UID}');
     insert into public.route_duel_players (room_id, profile_id) values ('${ROOM}','${UID}');
     -- misafir satırı: profile_id NULL
     insert into public.duel_players (room_id, profile_id, guest_id) values ('${ROOM}', null, gen_random_uuid());`);

  const generic = (uid: string, mode: string, room: string) =>
    q(`set torble.uid='${uid}'; select public.award_xp_event('${uid}','${mode}','${room}',500,'win','{}'::jsonb)::text;`);

  // EXPLOIT: rastgele UUID
  for (const mode of ["country_duel", "flag_duel", "wheel_duel", "group_country", "route_duel"]) {
    ok(
      hasAll(generic(UID, mode, FAKE), '"awarded": false', '"not_a_participant"'),
      `T-04 runtime EXPLOIT: ${mode} rastgele UUID ile XP BASILAMADI`,
    );
  }
  // MEŞRU
  for (const mode of ["country_duel", "wheel_duel", "group_country", "route_duel"]) {
    ok(
      generic(UID, mode, ROOM).includes('"awarded": true'),
      `T-04 runtime MEŞRU: ${mode} gerçek maçta XP yazıldı`,
    );
  }
  // İdempotency
  ok(
    /"already_claimed"/.test(generic(UID, "country_duel", ROOM)),
    "T-04 runtime: idempotency korundu (already_claimed)",
  );
  // Ölü anahtarlar
  for (const mode of ["photo_duel", "city_duel"]) {
    ok(
      hasAll(generic(UID, mode, ROOM), '"awarded": false', '"unsupported_mode"'),
      `T-04 runtime: ölü anahtar ${mode} reddedildi (unsupported_mode)`,
    );
  }
  // Çapraz kullanıcı + unauth (ikisi de exception fırlatır → psqlSafe)
  ok(
    /profile_id_mismatch/.test(psqlSafe(container, DB,
      `set torble.uid='${UID}';
       select public.award_xp_event('${OTHER}','country_duel','${ROOM}',500,'win','{}'::jsonb);`)),
    "T-04 runtime: başkasına XP yazılamıyor (profile_id_mismatch)",
  );
  ok(
    /auth_required/.test(psqlSafe(container, DB,
      `set torble.uid='';
       select public.award_xp_event('${UID}','country_duel','${ROOM}',500,'win','{}'::jsonb);`)),
    "T-04 runtime: unauth XP yazamıyor (auth_required)",
  );

  // Adanmış RPC'ler
  const dedicated: Array<[string, string]> = [
    ["award_conquest_xp_event", "conquest"],
    ["award_wheel_group_xp_event", "wheel_group"],
    ["award_kornokta_xp_event", "kornokta"],
  ];
  for (const [rpc] of dedicated) {
    ok(
      hasAll(q(`set torble.uid='${UID}'; select public.${rpc}('${UID}','${FAKE}',500,'win','{}'::jsonb)::text;`),
        '"awarded": false', '"not_a_participant"'),
      `T-04 runtime EXPLOIT: ${rpc} rastgele UUID ile XP BASILAMADI`,
    );
    ok(
      q(`set torble.uid='${UID}'; select public.${rpc}('${UID}','${ROOM}',500,'win','{}'::jsonb)::text;`)
        .includes('"awarded": true'),
      `T-04 runtime MEŞRU: ${rpc} gerçek maçta XP yazıldı`,
    );
  }

  // Misafir (profile_id NULL) hiçbir zaman katılımcı sayılmamalı.
  ok(
    q(`select public._xp_is_room_participant('country_duel','${ROOM}',null)::text;`) === "false",
    "T-04 runtime: misafir/NULL profil katılımcı sayılmıyor",
  );

  // harita_duel: grant kapalı + gövde awarded:false
  ok(
    q(`select has_function_privilege('authenticated','public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb)','EXECUTE')::text;`) === "false" &&
    q(`select has_function_privilege('anon','public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb)','EXECUTE')::text;`) === "false",
    "T-04/T-05 runtime: harita_duel EXECUTE hiçbir istemci rolünde yok",
  );
  ok(
    q(`set torble.uid='${UID}';
       select public.award_harita_duel_xp_event('${UID}','${ROOM}',500,'win','{}'::jsonb)::text;`)
      .includes('"awarded": false'),
    "T-04/T-05 runtime: harita_duel gövdesi her koşulda awarded:false (ikinci katman)",
  );

  // Grantlar
  for (const sig of [
    "public.award_xp_event(uuid,text,uuid,int,text,jsonb)",
    "public.award_conquest_xp_event(uuid,uuid,int,text,jsonb)",
    "public.award_wheel_group_xp_event(uuid,uuid,int,text,jsonb)",
    "public.award_kornokta_xp_event(uuid,uuid,int,text,jsonb)",
  ]) {
    ok(
      q(`select has_function_privilege('anon','${sig}','EXECUTE')::text;`) === "false" &&
      q(`select has_function_privilege('authenticated','${sig}','EXECUTE')::text;`) === "true",
      `T-04 runtime: ${sig.split("(")[0]} anon kapalı / authenticated açık`,
    );
  }

  // Sözleşme kapısı gerçekten koruyor mu? Uyumsuz bir gövdeyle migration DURMALI.
  const GUARD_DB = DB + "_guard";
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `drop database if exists ${GUARD_DB}`], { stdio: "ignore" });
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `create database ${GUARD_DB}`], { stdio: "ignore" });
  psql(container, GUARD_DB, SCHEMA);
  // mode_key listesini bozarak "canlı gövde beklenenden farklı" durumunu kur.
  psql(container, GUARD_DB, `
    create or replace function public.award_xp_event(
      p_profile_id uuid, p_mode_key text, p_room_id uuid,
      p_xp_earned int, p_result text, p_details jsonb default '{}'::jsonb
    ) returns jsonb language plpgsql security definer set search_path = public as $fn$
    begin
      insert into public.xp_events (profile_id,mode_key,room_id,xp_earned,result)
      values (p_profile_id,'country_duel',p_room_id,1,'win')
      on conflict (profile_id, mode_key, room_id) do nothing;
      return '{}'::jsonb;
    end $fn$;`);
  let guardBlocked = false;
  try {
    psql(container, GUARD_DB, read(XP_MIG));
  } catch (e) {
    guardBlocked = /T-04 DURDU/.test(String((e as { stderr?: Buffer }).stderr ?? e));
  }
  ok(guardBlocked, "T-04 runtime: sözleşme kapısı UYUMSUZ canlı gövdede migration'ı DURDURUYOR");

  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `drop database if exists ${DB}`], { stdio: "ignore" });
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-q", "-c", `drop database if exists ${GUARD_DB}`], { stdio: "ignore" });
}

/** psql çağrısı hata fırlatırsa mesajı string olarak döndürür (negatif testler için). */
function psqlSafe(c: string, db: string, sql: string): string {
  try { return psql(c, db, sql, true); }
  catch (e) { return String((e as { stderr?: Buffer }).stderr ?? e); }
}

/* ════════════════════════════════════════════════════════════════════════ */

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass}/${pass + fail} assertion geçti`);
if (fail > 0) {
  console.error("\nBAŞARISIZ:");
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
