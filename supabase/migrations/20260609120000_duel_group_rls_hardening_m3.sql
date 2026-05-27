-- ============================================================================
-- Duel Group (Online Çok Oyunculu Ülke Yaz) — RLS hardening · M3 (lockdown)
-- ============================================================================
-- AMAÇ
-- ----
-- M1 (altyapı: profile_id/guest_id kolonları + duel_group_player_claims +
-- duel_group_authorize_* helper'ları) ve M2 (11 RPC) sonrası, frontend
-- (DuelGroupGame.tsx) tüm yazma yollarını RPC'ye geçirdi (FE switch
-- doğrulandı: kalan direct write = 0; tüm 13 duel_group_* referansı SELECT).
-- Artık eski geniş "anon FOR ALL" ve "authenticated FOR ALL" politikalarını
-- kaldırıyoruz; yazma yolu yalnızca M2 RPC'leri (SECURITY DEFINER) üzerinden
-- mümkün.
--
-- SELECT yetkileri korunur — realtime abonelikleri, oda kodu lookup'ı,
-- lobi player listesi, claim akışı, leaderboard hesabı, opponent monitor
-- için ZORUNLU.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel + wheel_group + conquest +
-- duel 1v1 hardening'lerinde beş kez doğrulandı. Bu dosya aynı pattern'in
-- Duel Group karşılığıdır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_messages — bilinçli olarak HARİÇ TUTULDU.
--       duel_messages tablosu conquest / wheel_group / wheel_duel / flag_duel /
--       Duel 1v1 / Duel Group modlarının LobbyChat'i tarafından paylaşımlı
--       kullanılıyor. Duel 1v1 chat akışı duel_send_message RPC'ye geçti,
--       fakat Duel Group dahil diğer modlar hâlâ doğrudan duel_messages.insert
--       atıyor. Bu tabloya M3'te dokunmak Duel Group chat'i ve diğer modların
--       chat'ini kırar. Ayrı bir "global chat hardening" adımı (M4) ile her
--       mod kendi *_send_message RPC'sini aldıktan sonra duel_messages
--       lockdown'ı toplu yapılacak.
--   • duel_group_player_claims — M1 zaten doğru kurdu (INSERT-only policy,
--     SELECT grant'ı YOK, realtime publication DIŞI). Bu M3 ona dokunmaz.
--   • duel_group_rooms_cleanup_after_player_delete trigger (20260520130000)
--     ve onun açtığı duel_group_players REPLICA IDENTITY FULL. Trigger
--     SECURITY DEFINER (varsayım, mevcut migration'a göre) → RLS bypass eder,
--     non-host leave sonrası boş oda cleanup'ını yapmaya devam eder.
--   • supabase_realtime publication üyelikleri (duel_group_rooms,
--     duel_group_players, duel_group_claims — hepsi olduğu gibi kalır).
--   • Mevcut SATIRLAR (backfill yok; eski satırlar M1 öncesi profile_id/
--     guest_id NULL olarak kalır; yalnız okunabilir).
--   • Mevcut M2 RPC'lerinin signature ve gövdesi (yalnız policy değişiyor).
--   • Duel 1v1 (duel_rooms / duel_players / duel_claims / duel_player_claims /
--     duel_*_RPC'leri) — M1+M2+M3+patch ile sertleşti, dokunulmaz.
--   • wheel_duel_*, wheel_group_*, conquest_* — kendi hardening setleri.
--   • flag_duel_queue + flag_duel_quick_match / cancel RPC'leri.
--
-- DEĞİŞEN POLİTİKALAR
-- -------------------
--   duel_group_rooms:
--     SELECT  → herkes (realtime + invite-link oda kodu lookup için)
--     INSERT  → policy YOK → tek yol duel_group_create_room RPC
--     UPDATE  → policy YOK → tek yol duel_group_start_game /
--                            duel_group_finish_game / duel_group_update_settings /
--                            duel_group_return_to_lobby RPC'leri
--     DELETE  → policy YOK → tek yol duel_group_leave_room RPC (yalnız host) +
--                            duel_group_rooms_cleanup_after_player_delete
--                            trigger (SECURITY DEFINER)
--   duel_group_players:
--     SELECT  → herkes (lobi listesi, leaderboard, opponent monitor için)
--     INSERT  → kısıtlı defansif: profile_id = auth.uid() VEYA
--               (profile_id NULL ve guest_id dolu). Pratikte SECURITY DEFINER
--               RPC'leri bu policy'i bypass eder; defense-in-depth amaçlı.
--     UPDATE  → policy YOK → tek yol duel_group_heartbeat /
--                            duel_group_mark_finished / duel_group_start_game /
--                            duel_group_return_to_lobby / duel_group_leave_room
--                            (host transfer is_host UPDATE) RPC'leri
--     DELETE  → policy YOK → tek yol duel_group_leave_room /
--                            duel_group_kick_player RPC'leri (+ trigger cascade)
--   duel_group_claims:
--     SELECT  → herkes (realtime claim INSERT akışı + leaderboard COUNT için)
--     INSERT  → policy YOK → tek yol duel_group_submit_claim RPC
--     UPDATE  → policy YOK (claim'ler immutable)
--     DELETE  → policy YOK → tek yol duel_group_start_game (eski maç temizliği)
--                            ve duel_group_submit_claim (stale-claim retry)
--                            RPC'leri içinde
--
-- TEMİZLEME STRATEJİSİ
-- --------------------
-- DuelGroupGame.tsx başındaki belgelenmiş eski policy isimleri:
--   • anon_all_group_rooms / anon_all_group_players / anon_all_group_claims
--     (FOR ALL TO anon USING(true) WITH CHECK(true))
-- + 20260522120000 ile kurulmuş:
--   • duel_group_claims_all_authenticated (FOR ALL TO authenticated)
--
-- Studio'da manuel başka isimle (örn. "Enable all access for anon") kurulmuş
-- policy'ler de olabilir. İki kademeli temizleme:
--   (a) Bilinen aday isimleri "drop policy if exists" ile temizle
--   (b) DO block ile her tabloda kalan TÜM INSERT/UPDATE/DELETE policy'lerini
--       dinamik drop et (unknown isimlere karşı defansif net)
-- SELECT policy'lerine dokunmuyoruz; kendi `*_select_public` policy'lerimizi
-- yarat — varsa eski SELECT policy'leri ile birlikte aktif kalır (OR semantik).
--
-- CANLI ODA / MID-FLIGHT ETKİSİ
-- ------------------------------
--   • Frontend FE switch tamamlandı → tüm modern client'lar RPC kullanıyor.
--   • Eski deploy cached JS hâlâ açık sekmede çalışıyorsa, direkt INSERT/
--     UPDATE/DELETE'leri RLS default-deny tarafından reddedilir. Kullanıcı
--     sayfayı reload edince yeni JS yüklenir. Bu, prior beş hardening'inde
--     kabul edilen bilinçli takasın aynısı.
--   • Mid-flight bir maçta: aktif RPC çağrıları M2 fonksiyonlarından geçtiği
--     için SECURITY DEFINER ile RLS bypass eder → maç bozulmaz.
--   • Host transfer (leave_room RPC) ve boş oda cleanup (RPC içinde + trigger)
--     RLS'i bypass eder; lockdown sonrası da çalışır.
--
-- TEHDİT MODELİ ÖZETİ
-- -------------------
--   • anon-key sahibi 3. parti artık doğrudan:
--       - Başka odanın status / started_at / updated_at / duration / region /
--         max_players alanlarını yazamaz
--       - Bir oyuncunun is_host flag'ini yazamaz (host hijacking yok)
--       - Bir oyuncunun last_seen_at'ini güncelleyemez (heartbeat spoof yok)
--       - Sahte duel_group_claims insert ile skor üretemez
--       - Başkasının player satırını silemez (kick spoof yok)
--       - Başkasının odasını silemez
--   • Tüm yazımlar M2 RPC'leri üzerinden gider; her RPC'de
--     duel_group_authorize_player / duel_group_authorize_host claim_token
--     veya auth.uid() kanıtı zorunlu.
--   • submit_claim sunucu tarafı player_room_mismatch + status='playing'
--     guard'ları ile spoof'a karşı sağlam; stale-claim retry server-side.
--   • Misafir kimliği localStorage'daki claim_token'a bağlı; sekme temizliğiyle
--     kanıt kaybı kabul edilen takastır (prior beş hardening ile aynı).
--
-- IDEMPOTENT
-- ----------
--   • Tüm policy işlemleri "drop policy if exists" + "create policy". DO block
--     dinamik drop'ları da existence-check sonrası çalışır. Migration tekrar
--     koşulursa hata vermez.
--
-- ROLLBACK
-- --------
-- Aşağıdaki SQL bloğu canlı ortamda M3 hatası saptanırsa eski geniş policy'leri
-- geri açar (acil revert; M2 RPC'leri etkilenmez). DEFAULT olarak ÇALIŞTIRILMAZ;
-- yalnız manuel kopyala-yapıştır ile.
--
--   -- ROLLBACK ───────────────────────────────────────────────────────────
--   -- SELECT policy'leri zaten korunmuştu; INSERT/UPDATE/DELETE'i geri
--   -- açıyoruz. Bu DuelGroupGame.tsx'in FE switch ÖNCESİ direct-write
--   -- yollarını yeniden çalıştırır; M2 RPC'leri RLS bypass ile bu policy'lerden
--   -- bağımsız çalışmaya devam eder.
--   create policy "anon_all_group_rooms"
--     on public.duel_group_rooms
--     for all to anon, authenticated
--     using (true) with check (true);
--
--   drop policy if exists "duel_group_players_insert_self" on public.duel_group_players;
--   create policy "anon_all_group_players"
--     on public.duel_group_players
--     for all to anon, authenticated
--     using (true) with check (true);
--
--   create policy "anon_all_group_claims"
--     on public.duel_group_claims
--     for all to anon
--     using (true) with check (true);
--   create policy "duel_group_claims_all_authenticated"
--     on public.duel_group_claims
--     for all to authenticated
--     using (true) with check (true);
--   -- ROLLBACK SONU ──────────────────────────────────────────────────────
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_group_rooms — INSERT/UPDATE/DELETE policy'lerini kaldır, SELECT bırak
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bilinen aday eski policy isimleri (DuelGroupGame.tsx başındaki belgeli
--     isimler + wheel/duel pattern'i)
drop policy if exists "anon_all_group_rooms"        on public.duel_group_rooms;
drop policy if exists "anon_insert_group_rooms"     on public.duel_group_rooms;
drop policy if exists "anon_update_group_rooms"     on public.duel_group_rooms;
drop policy if exists "anon_delete_group_rooms"     on public.duel_group_rooms;
drop policy if exists "anon_select_group_rooms"     on public.duel_group_rooms;
drop policy if exists "duel_group_rooms_insert_anon" on public.duel_group_rooms;
drop policy if exists "duel_group_rooms_update_anon" on public.duel_group_rooms;
drop policy if exists "duel_group_rooms_delete_anon" on public.duel_group_rooms;
drop policy if exists "duel_group_rooms_all_anon"    on public.duel_group_rooms;
drop policy if exists "Enable all access for anon"   on public.duel_group_rooms;
drop policy if exists "Enable insert for anon"       on public.duel_group_rooms;
drop policy if exists "Enable update for anon"       on public.duel_group_rooms;
drop policy if exists "Enable delete for anon"       on public.duel_group_rooms;
-- Re-run idempotency:
drop policy if exists "duel_group_rooms_select_public" on public.duel_group_rooms;

-- (b) Defansif: kalan TÜM INSERT/UPDATE/DELETE policy'lerini dinamik drop et
do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_group_rooms'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  loop
    execute format(
      'drop policy if exists %I on public.duel_group_rooms',
      pol.policyname
    );
  end loop;
end$$;

-- RLS açık olduğundan emin ol (Studio'da kapalı kurulmuş olsaydı bile)
alter table public.duel_group_rooms enable row level security;

-- SELECT: herkes (realtime + invite-link oda kodu lookup için zorunlu)
create policy "duel_group_rooms_select_public"
  on public.duel_group_rooms
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → RLS default-deny → tüm doğrudan client write'ları reddedilir.
-- → Yazma yolu: duel_group_create_room, duel_group_join_room,
--   duel_group_update_settings, duel_group_start_game,
--   duel_group_finish_game, duel_group_return_to_lobby,
--   duel_group_leave_room RPC'leri (M2; hepsi SECURITY DEFINER) +
--   duel_group_rooms_cleanup_after_player_delete trigger.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_group_players — INSERT defansif kalsın; UPDATE/DELETE policy YOK
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "anon_all_group_players"        on public.duel_group_players;
drop policy if exists "anon_insert_group_players"     on public.duel_group_players;
drop policy if exists "anon_update_group_players"     on public.duel_group_players;
drop policy if exists "anon_delete_group_players"     on public.duel_group_players;
drop policy if exists "anon_select_group_players"     on public.duel_group_players;
drop policy if exists "duel_group_players_insert_anon" on public.duel_group_players;
drop policy if exists "duel_group_players_update_anon" on public.duel_group_players;
drop policy if exists "duel_group_players_delete_anon" on public.duel_group_players;
drop policy if exists "duel_group_players_all_anon"    on public.duel_group_players;
drop policy if exists "Enable all access for anon"     on public.duel_group_players;
drop policy if exists "Enable insert for anon"         on public.duel_group_players;
drop policy if exists "Enable update for anon"         on public.duel_group_players;
drop policy if exists "Enable delete for anon"         on public.duel_group_players;
-- Re-run idempotency:
drop policy if exists "duel_group_players_select_public" on public.duel_group_players;
drop policy if exists "duel_group_players_insert_self"   on public.duel_group_players;

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_group_players'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  loop
    execute format(
      'drop policy if exists %I on public.duel_group_players',
      pol.policyname
    );
  end loop;
end$$;

alter table public.duel_group_players enable row level security;

-- SELECT: herkes (lobi player listesi, leaderboard, opponent monitor için)
create policy "duel_group_players_select_public"
  on public.duel_group_players
  for select
  to anon, authenticated
  using (true);

-- INSERT defansif: pratikte duel_group_create_room / duel_group_join_room
-- RPC'leri SECURITY DEFINER ile bypass eder. Bu policy yalnız RPC-dışı
-- INSERT'lere karşı defense-in-depth:
--   - Logged-in: profile_id zorunlu, auth.uid() ile eşleşmeli
--   - Misafir:   profile_id NULL, guest_id dolu olmalı
create policy "duel_group_players_insert_self"
  on public.duel_group_players
  for insert
  to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- KASITLI: UPDATE / DELETE policy YOK.
-- → duel_group_heartbeat (last_seen_at), duel_group_mark_finished (status),
--   duel_group_start_game (status reset + last_seen_at hizala),
--   duel_group_return_to_lobby (host'un kendi satırı),
--   duel_group_leave_room (host transfer is_host UPDATE + self DELETE),
--   duel_group_kick_player (target DELETE)
--   M2 RPC'leri SECURITY DEFINER ile bypass eder.


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_group_claims — INSERT/UPDATE/DELETE policy'lerini kaldır, SELECT bırak
-- ----------------------------------------------------------------------------
-- BURADA EK: 20260522120000_duel_group_claims_auth_policy.sql ile kurulmuş
-- "duel_group_claims_all_authenticated" (FOR ALL TO authenticated) policy'sini
-- de kaldırıyoruz. Bu policy login'li kullanıcılara claims tablosuna full
-- access veriyordu; M2 sonrası gereksiz — submit_claim RPC + start_game RPC
-- içindeki temizlik tek yol.
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "anon_all_group_claims"                  on public.duel_group_claims;
drop policy if exists "duel_group_claims_all_authenticated"    on public.duel_group_claims;
drop policy if exists "anon_insert_group_claims"               on public.duel_group_claims;
drop policy if exists "anon_update_group_claims"               on public.duel_group_claims;
drop policy if exists "anon_delete_group_claims"               on public.duel_group_claims;
drop policy if exists "anon_select_group_claims"               on public.duel_group_claims;
drop policy if exists "duel_group_claims_insert_anon"          on public.duel_group_claims;
drop policy if exists "duel_group_claims_update_anon"          on public.duel_group_claims;
drop policy if exists "duel_group_claims_delete_anon"          on public.duel_group_claims;
drop policy if exists "Enable all access for anon"             on public.duel_group_claims;
drop policy if exists "Enable insert for anon"                 on public.duel_group_claims;
-- Re-run idempotency:
drop policy if exists "duel_group_claims_select_public"        on public.duel_group_claims;

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_group_claims'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  loop
    execute format(
      'drop policy if exists %I on public.duel_group_claims',
      pol.policyname
    );
  end loop;
end$$;

alter table public.duel_group_claims enable row level security;

-- SELECT: herkes (realtime claim INSERT akışı + freezeLeaderboard COUNT için)
create policy "duel_group_claims_select_public"
  on public.duel_group_claims
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → INSERT tek yolu duel_group_submit_claim RPC (player_room_mismatch +
--   status='playing' + stale-claim retry + UNIQUE atomik guard).
-- → DELETE: start_game (eski maç temizliği) ve submit_claim (stale retry)
--   RPC'leri içinde. Doğrudan client DELETE'i artık reddedilir.
-- → UPDATE: claim'ler immutable; oda DELETE'iyle cascade temizlenir.


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_messages — KASITLI ÇIKARILDI
-- ----------------------------------------------------------------------------
-- duel_messages tablosu paylaşımlı bir chat altyapısı (DuelGroupGame.tsx +
-- conquest + wheel_group + wheel_duel + flag_duel modlarının LobbyChat'i bu
-- tabloyu kullanıyor). Yalnız Duel 1v1 modu duel_send_message RPC'ye geçti.
-- Duel Group LobbyChat hâlâ default "direct" yolunu kullanıyor; bu tabloya
-- M3'te dokunmak Duel Group chat'ini ve diğer modları kırar. Global chat
-- hardening (M4) ile her mod kendi *_send_message RPC'sini aldıktan sonra
-- duel_messages lockdown'ı toplu yapılacak.
-- ────────────────────────────────────────────────────────────────────────────
-- (no-op)


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_group_player_claims — M1 KORUNUR
-- ----------------------------------------------------------------------------
-- M1 (20260607120000) duel_group_player_claims tablosunu zaten doğru kurdu:
--   • RLS açık
--   • INSERT-only policy ("duel_group_player_claims_insert", anon+authenticated)
--   • SELECT/UPDATE/DELETE grant YOK (revoke ile)
--   • supabase_realtime publication DIŞI
-- Bu M3 ona dokunmaz; aksi davranış token rotation/leak yaratırdı.
-- ────────────────────────────────────────────────────────────────────────────
-- (no-op)


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel, Studio SQL editor'de):
--
--   -- Beklenen final policy listesi:
--   --   duel_group_rooms         → duel_group_rooms_select_public         (SELECT)
--   --   duel_group_players       → duel_group_players_select_public       (SELECT)
--   --                            → duel_group_players_insert_self         (INSERT)
--   --   duel_group_claims        → duel_group_claims_select_public        (SELECT)
--   --   duel_group_player_claims → duel_group_player_claims_insert        (INSERT) [M1]
--   --   duel_messages            → (Studio'daki mevcut policy'ler — DOKUNULMADI)
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in (
--        'duel_group_rooms', 'duel_group_players', 'duel_group_claims',
--        'duel_group_player_claims', 'duel_messages'
--      )
--    order by tablename, cmd, policyname;
--
--   -- duel_group_rooms/players/claims'de INSERT/UPDATE/DELETE/ALL policy KALMAMALI
--   -- (duel_group_players_insert_self hariç):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_group_rooms', 'duel_group_players', 'duel_group_claims')
--      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
--      and policyname <> 'duel_group_players_insert_self';
--   -- Beklenen: 0 satır
--
--   -- RLS açık mı?
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('duel_group_rooms', 'duel_group_players', 'duel_group_claims');
--   -- Beklenen: 3 satır, relrowsecurity=true.
--
--   -- Negatif test (anon JWT ile psql veya sql editor üzerinde):
--   --   insert into public.duel_group_rooms (code, status, duration_seconds, region, max_players)
--   --     values ('GTEST1','waiting',60,'world',5);
--   --   → "new row violates row-level security policy" hatası beklenir.
--   --   update public.duel_group_rooms set status='finished' where id='<X>';
--   --   → reddedilmeli.
--   --   delete from public.duel_group_rooms where id='<X>';
--   --   → reddedilmeli.
--   --   insert into public.duel_group_claims (room_id, player_id, country_code)
--   --     values ('<R>', '<P>', 'TUR');
--   --   → reddedilmeli.
--   --   update public.duel_group_players set is_host=true where id='<P>';
--   --   → reddedilmeli (host hijacking yok).
--   --   delete from public.duel_group_players where id='<P>';
--   --   → reddedilmeli (kick spoof yok).
--
--   -- Authenticated user için de aynı negatif test:
--   --   (önceki duel_group_claims_all_authenticated policy'si kalmadığı için)
--   --   insert into public.duel_group_claims (...) → reddedilmeli.
--
--   -- M2 RPC'leri hâlâ çalışmalı (smoke, uygun parametrelerle):
--   --   select * from public.duel_group_create_room(...);
--   --   select public.duel_group_submit_claim(...);
--   --   → başarılı dönmeli (claim_token + identity doğru ise).
-- ============================================================================
