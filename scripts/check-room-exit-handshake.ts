/**
 * check-room-exit-handshake.ts — ortak güvenli çıkış el sıkışması (audit M1).
 *
 * `requestRoomExit` saf DOM olayı üzerinden çalışır; React, Supabase ve ağ
 * GEREKMEZ. Burada bir mod bileşeninin yerine minik sahte dinleyiciler
 * kullanılır — sözleşme test edilir, mod içi mantık değil.
 *
 *   npx tsx scripts/check-room-exit-handshake.ts
 */
// jsdom yok: `window`u global EventTarget ile sağlıyoruz. requestRoomExit
// yalnız addEventListener/removeEventListener/dispatchEvent + CustomEvent kullanır
// (ikisi de Node 18+ globalinde var).
const target = new EventTarget() as unknown as Window & typeof globalThis;
(globalThis as unknown as { window: Window }).window = target;

const { requestRoomExit, ROOM_EXIT_REQUEST_EVENT } = await import("../src/lib/roomExit");
type Detail = import("../src/lib/roomExit").RoomExitRequestDetail;

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, label: string) => { if (c) pass++; else fails.push(label); };
const eq = <T,>(a: T, b: T, label: string) =>
  ok(Object.is(a, b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/** Bir mod bileşenini taklit eder: mode eşleşirse ve canExit ise üstlenir. */
function mountFakeMode(opts: {
  mode: string;
  canExit: () => boolean;
  exit: () => Promise<void>;
  onClaim?: () => void;
}) {
  const listener = (e: Event) => {
    const d = (e as CustomEvent<Detail>).detail;
    if (!d || d.mode !== opts.mode) return;
    if (!opts.canExit()) return;
    opts.onClaim?.();
    d.claim(opts.exit());
  };
  window.addEventListener(ROOM_EXIT_REQUEST_EVENT, listener);
  return () => window.removeEventListener(ROOM_EXIT_REQUEST_EVENT, listener);
}

/* ── 1) Dinleyici yoksa: TAHMİN YOK, kesin "aktif oda yok" ───────────── */
{
  const r = await requestRoomExit("duel");
  eq(r.ok, false, "no listener → not ok");
  ok(!r.ok && r.reason === "no-active-room", "no listener → reason=no-active-room");
}

/* ── 2) Mod mount ama odada değil → üstlenmez ────────────────────────── */
{
  let exitCalls = 0;
  const un = mountFakeMode({
    mode: "duel", canExit: () => false,
    exit: async () => { exitCalls++; },
  });
  const r = await requestRoomExit("duel");
  ok(!r.ok && r.reason === "no-active-room", "canExit=false → no-active-room");
  eq(exitCalls, 0, "canExit=false → exit ÇAĞRILMAZ");
  un();
}

/* ── 3) Başarılı çıkış ───────────────────────────────────────────────── */
{
  let exitCalls = 0;
  const un = mountFakeMode({
    mode: "duel", canExit: () => true,
    exit: async () => { exitCalls++; },
  });
  const r = await requestRoomExit("duel");
  eq(r.ok, true, "successful exit → ok");
  eq(exitCalls, 1, "exit tam olarak BİR kez çağrılır");
  un();
}

/* ── 4) Çıkış hata verirse: ok=false, sebep exit-failed ──────────────── */
{
  const boom = new Error("leave_room failed");
  const un = mountFakeMode({
    mode: "duel", canExit: () => true,
    exit: async () => { throw boom; },
  });
  const r = await requestRoomExit("duel");
  eq(r.ok, false, "throwing exit → not ok");
  ok(!r.ok && r.reason === "exit-failed", "throwing exit → reason=exit-failed");
  ok(!r.ok && r.reason === "exit-failed" && r.error === boom, "orijinal hata taşınır");
  un();
}

/* ── 5) Yalnız HEDEF mod üstlenir; diğer modlar dokunulmaz ───────────── */
{
  let duelExits = 0, conquestExits = 0;
  const a = mountFakeMode({ mode: "duel", canExit: () => true, exit: async () => { duelExits++; } });
  const b = mountFakeMode({ mode: "conquest", canExit: () => true, exit: async () => { conquestExits++; } });
  const r = await requestRoomExit("conquest");
  eq(r.ok, true, "targeted mode exits");
  eq(duelExits, 0, "hedef olmayan mod ÇIKMAZ");
  eq(conquestExits, 1, "hedef mod bir kez çıkar");
  a(); b();
}

/* ── 6) İki dinleyici aynı modu üstlenmeye kalkarsa: ilk claim kazanır ── */
{
  let first = 0, second = 0;
  const a = mountFakeMode({ mode: "duel", canExit: () => true, exit: async () => { first++; } });
  const b = mountFakeMode({ mode: "duel", canExit: () => true, exit: async () => { second++; } });
  const r = await requestRoomExit("duel");
  eq(r.ok, true, "double listener still resolves");
  eq(first + second, 2, "her iki sahte dinleyici de exit() başlattı (sahte kurulum)");
  a(); b();
  // Sözleşme: App YALNIZ ilk claim'in promise'ini bekler → sonuç tek.
}

/* ── 7) Çıkış tamamlanmadan ok DÖNMEZ (timeout ile başarı varsayımı yok) ── */
{
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const un = mountFakeMode({
    mode: "duel", canExit: () => true,
    exit: async () => { await gate; order.push("exit-done"); },
  });
  const p = requestRoomExit("duel").then((r) => { order.push(r.ok ? "resolved-ok" : "resolved-fail"); });
  // Birkaç mikro/makro tick: hâlâ çözülmemiş olmalı.
  await new Promise((r) => setTimeout(r, 30));
  eq(order.length, 0, "çıkış bitmeden requestRoomExit ÇÖZÜLMEZ");
  release();
  await p;
  eq(order.join(","), "exit-done,resolved-ok", "sıra: önce çıkış biter, sonra ok döner");
  un();
}

/* ── 8) Unmount sonrası dinleyici kalmaz ─────────────────────────────── */
{
  const un = mountFakeMode({ mode: "duel", canExit: () => true, exit: async () => {} });
  un();
  const r = await requestRoomExit("duel");
  ok(!r.ok && r.reason === "no-active-room", "unmount → artık üstlenilmez");
}

console.log(`PASS ${pass}  FAIL ${fails.length}`);
fails.forEach((f) => console.log("  ✗", f));
process.exit(fails.length === 0 ? 0 : 1);
