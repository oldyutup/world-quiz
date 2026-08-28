-- ════════════════════════════════════════════════════════════════════════════
-- 20260827130000_wheel_duel_reset_quick_match.sql
--
-- ÇARK DÜELLO — "HIZLI EŞLEŞ" ESKİ MAÇI YENİDEN AÇIYOR (build 9 blocker'ı)
-- ════════════════════════════════════════════════════════════════════════════
-- SEMPTOM
-- ───────
--   "Hızlı Eşleş"e basınca bazen taze eşleşme başlamıyor; oyuncu ÖNCEKİ
--   (bitmiş/terk edilmiş) maça/lobiye sanki devam ediyormuş gibi düşüyor.
--
-- KÖK NEDEN — BAYAT DURUM SUNUCUDA, localStorage'DA DEĞİL
-- ────────────────────────────────────────────────────────
--   `wheel_duel_cancel_quick_match` — diğer modlardaki eşleriyle aynı şekilde —
--   YALNIZ `matched_room_id IS NULL` satırları siler (canlı eşleşmede karşı
--   tarafın realtime UPDATE'ini bozmamak için; bu tasarım DOĞRU). Sonuç:
--   eşleşmiş bir satır maç bittikten sonra `matched_room_id` DOLU hâlde
--   sonsuza kadar kalır.
--
--   İstemci tarafında `quickMatchTick` bir "SELECT-first guard" ile başlar:
--   kendi kuyruk satırını okur ve `matched_room_id` doluysa DOĞRUDAN o odaya
--   katılır. Yani "Hızlı Eşleş" düğmesi, önceki maçın kalıntısını "şu anki
--   eşleşmem" sanar. `clearWheelDuelSession()` (localStorage) buna ÇARE
--   DEĞİLDİR — bayat durum sunucudadır.
--
--   Bu kusur Bayrak Düello'da (20260521120000) ve Ülke Yaz'da
--   (20260701120000) TESPİT EDİLİP ÇÖZÜLDÜ; Kuşatma ve Rota Düello da aynı
--   deseni doğuştan taşıyor. ÇARK DÜELLO tek istisnadır: ne `reset` RPC'si
--   var, ne de istemci böyle bir çağrı yapıyor.
--
-- ÇÖZÜM
-- ─────
--   Diğer dört modun kanıtlanmış deseninin BİREBİR aynısı: yeni aramadan
--   hemen önce çağrılan, çağıranın KENDİ kuyruk satırını koşulsuz silen küçük
--   bir RPC. `auth.uid()` eşitliği tek satırla sınırlar.
--
--   Not: bu, "Hızlı Eşleş"in tazeliğini garanti eden İKİ katmandan biridir.
--   İkinci katman istemcidedir (validate-before-commit + stale-room guard:
--   status/started_at doğrulanmadan hiçbir odaya bağlanılmaz), böylece bu RPC
--   ağ hatasıyla düşse bile bitmiş/terk edilmiş/silinmiş oda ASLA açılmaz.
--
-- KAPSAM
-- ──────
--   • YALNIZ yeni bir fonksiyon ekler. Tablo/kolon/index/policy değişikliği
--     YOK. `wheel_duel_quick_match` ve `wheel_duel_cancel_quick_match`
--     DEĞİŞMEZ (gövdeleri repoda yok; bu migration onlara dokunmaz).
--   • Başka hiçbir mod (duel_*, flag_*, conquest_*, route_duel_*, tevatur_*)
--     etkilenmez.
--   • `wheel_duel_queue` üzerindeki istemci YAZMA yetkileri 20260814180000'de
--     geri alındı; bu RPC SECURITY DEFINER olduğu için ondan etkilenmez ve o
--     kilidi GEVŞETMEZ.
--
-- IDEMPOTENT: create or replace.
-- DEPLOY: migration + istemci BİRLİKTE. PRODUCTION'A UYGULANMADI.
-- ════════════════════════════════════════════════════════════════════════════


-- ── ÖN KOŞUL ────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.wheel_duel_queue') is null then
    raise exception 'wheel_duel_queue yok — Çark Düello Hızlı Eşleş kurulmamış';
  end if;
end $$;


create or replace function public.wheel_duel_reset_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'wheel_duel_reset_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'wheel_duel_reset_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- Koşulsuz: eşleşmiş (matched_room_id dolu) satırlar da silinir — cancel'ın
  -- bilerek bıraktığı, "Hızlı Eşleş"i eski odaya sürükleyen kalıntı budur.
  delete from public.wheel_duel_queue
   where profile_id = p_profile_id;
end;
$$;

revoke all     on function public.wheel_duel_reset_quick_match(uuid) from public;
revoke all     on function public.wheel_duel_reset_quick_match(uuid) from anon;
grant  execute on function public.wheel_duel_reset_quick_match(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA (Studio SQL editor — uygulandıktan SONRA)
-- ════════════════════════════════════════════════════════════════════════════
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc where pronamespace = 'public'::regnamespace
--      and proname = 'wheel_duel_reset_quick_match';
--
--   -- anon EXECUTE kapalı olmalı (Hızlı Eşleş zaten login-gate'li):
--   select has_function_privilege('anon',
--          'public.wheel_duel_reset_quick_match(uuid)', 'EXECUTE');   -- false
--   select has_function_privilege('authenticated',
--          'public.wheel_duel_reset_quick_match(uuid)', 'EXECUTE');   -- true
--
--   -- Kendi JWT'siyle:
--   select wheel_duel_reset_quick_match('<my profile uuid>'::uuid);
--   select * from wheel_duel_queue where profile_id = '<my profile uuid>'::uuid;
--   -- beklenen: 0 satır
-- ════════════════════════════════════════════════════════════════════════════
