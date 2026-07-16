/**
 * check-daily-quest-migration.ts — Günün Görevi migration'ının statik denetimi.
 *
 * 20260803120000_daily_quest_init.sql üzerinde, canlı Postgres olmadan
 * yakalanabilecek hata sınıflarını tarar (42601 "record variable cannot be
 * part of multiple-item INTO list" regresyonu bu dosya yüzünden eklendi):
 *
 *   A) RECORD / %ROWTYPE / composite değişkenler çoklu INTO listesinde YOK
 *   B) Public RPC imzaları src/lib/dailyQuest.ts client çağrılarıyla uyumlu
 *   C) Internal helper'lar (_daily_quest_*) client rollerine kapalı
 *   D) daily_quest_claim_reward dönüşü client ClaimResult adapter'ıyla uyumlu
 *   E) revoke/grant imzaları bu migration'da yaratılan fonksiyonlarla eşleşiyor
 *   F) Migration kendi BEGIN/COMMIT/ROLLBACK'ini içermiyor (SQL Editor'da
 *      BEGIN; <dosya>; ROLLBACK; sarmalı denemesi için şart)
 *
 * Gerçek derleme doğrulaması yine canlı Supabase'de rollback'li yapılmalı;
 * bu script yalnız statik sözleşmeleri kilitler.
 *
 * Çalıştır:  npx tsx scripts/check-daily-quest-migration.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION_PATH = join(
  ROOT, "supabase/migrations/20260803120000_daily_quest_init.sql"
);
const CLIENT_PATH = join(ROOT, "src/lib/dailyQuest.ts");

const sql = readFileSync(MIGRATION_PATH, "utf8");
const client = readFileSync(CLIENT_PATH, "utf8");

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

/* ── SQL fonksiyon bloklarını ayrıştır ($fn$ gövdeli) ────────────────────── */

interface FnDef {
  name: string;          // public.xxx
  rawParams: string;     // imza parantez içi
  inParamNames: string[];
  inParamTypes: string[];
  requiredParamNames: string[]; // default'suz IN paramlar
  outParams: { name: string; type: string }[];
  body: string;
  lineStart: number;
}

function normalizeType(t: string): string {
  const s = t.trim().toLowerCase().replace(/\s+/g, " ");
  return ({ int: "integer", int4: "integer", bool: "boolean" } as Record<string, string>)[s] ?? s;
}

function splitParams(raw: string): string[] {
  // Bu migration'da parametre default'ları paren içermez; virgülle bölmek güvenli.
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

const fns: FnDef[] = [];
// Gövde dollar-tag'i fonksiyona göre değişir ($fn$ / $$) → backreference'la eşle.
const fnRe =
  /create or replace function (public\.[a-z0-9_]+)\s*\(([\s\S]*?)\)[\s\S]*?language (?:plpgsql|sql)[\s\S]*?as (\$[a-z_]*\$)([\s\S]*?)\3;/g;
for (const m of sql.matchAll(fnRe)) {
  const [, name, rawParams, , body] = m;
  const inNames: string[] = [];
  const inTypes: string[] = [];
  const required: string[] = [];
  const outs: { name: string; type: string }[] = [];
  for (const p of splitParams(rawParams)) {
    const pm = /^(out\s+)?([a-z0-9_]+)\s+([a-z0-9_. \[\]]+?)(\s+default\s+.+)?$/i.exec(p);
    if (!pm) { failed++; console.error(`  ✗ imza parse edilemedi: ${name} :: ${p}`); continue; }
    const [, isOut, pname, ptype, hasDefault] = pm;
    if (isOut) outs.push({ name: pname, type: normalizeType(ptype) });
    else {
      inNames.push(pname);
      inTypes.push(normalizeType(ptype));
      if (!hasDefault) required.push(pname);
    }
  }
  fns.push({
    name, rawParams, inParamNames: inNames, inParamTypes: inTypes,
    requiredParamNames: required, outParams: outs, body,
    lineStart: sql.slice(0, m.index).split("\n").length,
  });
}
const fnByName = new Map(fns.map((f) => [f.name, f]));

console.log(`\nA) Çoklu INTO listesinde record/rowtype/composite değişken taraması`);
ok(fns.length >= 12, `migration'dan fonksiyon bloğu ayrıştı (${fns.length})`, fns.length);

/* ── A) composite değişkenler + çoklu INTO ───────────────────────────────── */

const SCALAR_TYPES = new Set([
  "uuid", "text", "integer", "bigint", "boolean", "jsonb", "json", "date",
  "timestamptz", "timestamp", "interval", "numeric", "real", "double precision",
  "text[]", "uuid[]", "integer[]",
]);

let multiIntoTotal = 0;
for (const fn of fns) {
  // composite/record değişkenler: declare bloğu + imzadaki (OUT dahil) paramlar
  const composite = new Set<string>();
  for (const o of fn.outParams) if (!SCALAR_TYPES.has(o.type)) composite.add(o.name);
  fn.inParamNames.forEach((n, i) => {
    if (!SCALAR_TYPES.has(fn.inParamTypes[i])) composite.add(n);
  });
  const declMatch = /^\s*declare\b([\s\S]*?)^begin\b/im.exec(fn.body);
  if (declMatch) {
    for (const dm of declMatch[1].matchAll(
      /^\s*([a-z0-9_]+)\s+(record\b|[a-z0-9_.]+%rowtype\b|public\.[a-z0-9_]+)/gim
    )) composite.add(dm[1]);
  }

  for (const im of fn.body.matchAll(
    /\binto\s+(?:strict\s+)?([a-z0-9_]+(?:\s*,\s*[a-z0-9_]+)+)/gi
  )) {
    const before = fn.body.slice(Math.max(0, (im.index ?? 0) - 24), im.index ?? 0);
    if (/insert\s*$/i.test(before)) continue; // INSERT INTO tablo(kolonlar)
    multiIntoTotal++;
    const targets = im[1].split(",").map((t) => t.trim());
    const bad = targets.filter((t) => composite.has(t));
    ok(bad.length === 0,
      `${fn.name}: çoklu INTO '${targets.join(", ")}' composite hedef içermiyor`,
      bad.length ? bad : undefined);
  }
}
ok(true, `taranan çoklu INTO listesi sayısı: ${multiIntoTotal} (0 olması beklenir — hepsi tekli record'a çevrildi)`);
ok(multiIntoTotal === 0,
  "migration'da hiç çoklu INTO listesi kalmadı (helper'lar tek record'a alınıp dağıtılıyor)",
  multiIntoTotal);

/* ── B) Public RPC imzaları ↔ client çağrıları ──────────────────────────── */

console.log(`\nB) Public RPC imzaları ↔ src/lib/dailyQuest.ts çağrıları`);

// client: rpc<...>("name") ve rpc<...>("name", { p_x: ..., p_y: ... })
const clientCalls = new Map<string, Set<string>>();
for (const m of client.matchAll(
  /rpc(?:<[^>]+>)?\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g
)) {
  const keys = new Set<string>();
  for (const km of (m[2] ?? "").matchAll(/([a-z0-9_]+)\s*:/g)) keys.add(km[1]);
  clientCalls.set(m[1], keys);
}
ok(clientCalls.size === 7, `client 7 RPC çağırıyor`, [...clientCalls.keys()]);

for (const [name, keys] of clientCalls) {
  const fn = fnByName.get(`public.${name}`);
  ok(!!fn, `client'ın çağırdığı '${name}' migration'da tanımlı`);
  if (!fn) continue;
  const paramSet = new Set(fn.inParamNames);
  const unknown = [...keys].filter((k) => !paramSet.has(k));
  ok(unknown.length === 0,
    `${name}: client arg'ları imzada var (${[...keys].join(", ") || "argsız"})`, unknown.length ? unknown : undefined);
  const missing = fn.requiredParamNames.filter((p) => !keys.has(p));
  ok(missing.length === 0,
    `${name}: default'suz tüm paramlar client'tan gidiyor`, missing.length ? missing : undefined);
}

/* ── C) Internal helper grant'leri kapalı ────────────────────────────────── */

console.log(`\nC) Internal helper'lar client rollerine kapalı`);

const internals = fns.filter((f) => f.name.startsWith("public._daily_quest_"));
ok(internals.length >= 7, `internal helper sayısı (${internals.length})`, internals.map((f) => f.name));

const revokes = [...sql.matchAll(
  /revoke all on function (public\.[a-z0-9_]+)\s*\(([^)]*)\)\s*\n?\s*from ([a-z, ]+);/g
)].map((m) => ({
  name: m[1],
  argTypes: splitParams(m[2]).map(normalizeType),
  roles: m[3].split(",").map((r) => r.trim()),
}));
const grants = [...sql.matchAll(
  /grant execute on function (public\.[a-z0-9_]+)\s*\(([^)]*)\)\s*to ([a-z, ]+);/g
)].map((m) => ({
  name: m[1],
  argTypes: splitParams(m[2]).map(normalizeType),
  roles: m[3].split(",").map((r) => r.trim()),
}));

for (const fn of internals) {
  const rv = revokes.filter((r) => r.name === fn.name);
  ok(rv.length > 0, `${fn.name}: revoke satırı var`);
  ok(rv.some((r) => ["public", "anon", "authenticated"].every((role) => r.roles.includes(role))),
    `${fn.name}: public+anon+authenticated ÜÇÜNDEN de revoke edilmiş`,
    rv.map((r) => r.roles));
  ok(!grants.some((g) => g.name === fn.name),
    `${fn.name}: hiçbir role grant edilmemiş`);
}

/* ── D) Claim RPC dönüşü ↔ client ClaimResult ────────────────────────────── */

console.log(`\nD) daily_quest_claim_reward ↔ ClaimResult adapter kontratı`);

const claim = fnByName.get("public.daily_quest_claim_reward");
ok(!!claim, "claim fonksiyonu migration'da tanımlı");
if (claim) {
  ok(claim.inParamNames.join(",") === "p_attempt_id" && claim.inParamTypes.join(",") === "uuid",
    "claim imzası yalnız (p_attempt_id uuid) — client miktar/ödül GÖNDEREMEZ",
    claim.rawParams.trim());

  const ifaceMatch = /interface ClaimResult \{([\s\S]*?)\}/.exec(client);
  ok(!!ifaceMatch, "client ClaimResult interface'i bulundu");
  const ifaceFields = new Set(
    [...(ifaceMatch?.[1] ?? "").matchAll(/([a-z_]+)\??:/g)].map((m) => m[1])
  );
  for (const f of ["ok", "code", "gold", "amount"]) {
    ok(ifaceFields.has(f), `ClaimResult '${f}' alanını tanımlıyor`);
  }

  const returnedKeys = new Set(
    [...claim.body.matchAll(/jsonb_build_object\(([\s\S]*?)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]))
  );
  ok(["ok", "code", "gold", "amount"].every((k) => returnedKeys.has(k)),
    "claim dönüşleri ok/code/gold/amount anahtarlarını üretiyor",
    [...returnedKeys]);
  ok(/'ok',\s*true,\s*'gold',\s*v_gold,\s*'amount',\s*v_quest\.reward_gold/.test(claim.body),
    "başarı yolu gold+amount'u SUNUCU değerlerinden döner (v_gold, reward_gold)");
  ok(/already_claimed/.test(claim.body) && /_apply_gold_delta/.test(claim.body),
    "idempotent already_claimed yolu + _apply_gold_delta korunmuş");
}

/* ── E) revoke/grant imzaları yaratılan fonksiyonlarla eşleşiyor ─────────── */

console.log(`\nE) revoke/grant imza eşleşmesi (drop/create/grant drift)`);

for (const stmt of [...revokes, ...grants]) {
  const fn = fnByName.get(stmt.name);
  const isGrant = grants.includes(stmt as (typeof grants)[number]);
  const kind = isGrant ? "grant" : "revoke";
  // Bu migration daily-quest fonksiyonlarını yaratır; başka migration'ların
  // fonksiyonlarına dokunan satır bu dosyada beklenmez.
  ok(!!fn, `${kind} ${stmt.name}: fonksiyon bu migration'da yaratılmış`);
  if (fn) {
    ok(stmt.argTypes.join(",") === fn.inParamTypes.join(","),
      `${kind} ${stmt.name}(${stmt.argTypes.join(", ")}): arg tipleri imzayla birebir`,
      { stmt: stmt.argTypes, fn: fn.inParamTypes });
  }
}

/* ── F) Migration transaction-sarmalanabilir ─────────────────────────────── */

console.log(`\nF) Dosya kendi BEGIN/COMMIT/ROLLBACK'ini içermiyor`);

// Fonksiyon gövdelerini çıkar (plpgsql begin/end + iç exception blokları hariç)
const outsideBodies = sql.replace(/(\$[a-z_]*\$)[\s\S]*?\1/g, "$1…$1");
const txStmts = [...outsideBodies.matchAll(/^\s*(begin|commit|rollback)\s*;/gim)];
ok(txStmts.length === 0,
  "gövde dışında BEGIN;/COMMIT;/ROLLBACK; yok (SQL Editor'da dıştan sarılabilir)",
  txStmts.map((m) => m[1]));

/* ── Sonuç ───────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
