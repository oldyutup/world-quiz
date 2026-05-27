-- ============================================================================
-- Duel (Online 1v1 Ülke Yaz) — RLS hardening · M3 (lockdown)
-- ============================================================================
-- AMAÇ
-- ----
-- M1 (altyapı: profile_id/guest_id kolonları + host_player_id +
-- duel_player_claims + duel_authorize_* helper'ları) ve M2 (12 RPC) sonrası,
-- frontend de tüm yazma yollarını RPC'ye geçirdi. Artık eski geniş
-- "anon FOR ALL USING(true) WITH CHECK(true)" politikalarını kaldırıyoruz;
-- yazma yolu yalnızca M2 RPC'leri (SECURITY DEFINER) üzerinden mümkün.
--
-- SELECT yetkileri korunur — realtime abonelikleri, oda kodu lookup'ı,
-- lobi player listesi, claim listesi için ZORUNLU.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel + wheel_group + conquest
-- hardening'lerinde dört kez doğrulandı (20260527–20260602). Bu dosya aynı
-- pattern'in Duel 1v1 karşılığıdır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_messages — bilinçli olarak HARİÇ TUTULDU.
--       duel_messages tablosu conquest / wheel_group / wheel_duel / flag_duel /
--       duel_group modlarının LobbyChat'i tarafından da paylaşımlı kullanılıyor.
--       Duel 1v1 chat akışı M2'de duel_send_message RPC'ye geçti, fakat diğer
--       modlar hâlâ doğrudan duel_messages.insert atıyor. Bu tabloya bu M3'te
--       dokunmak diğer modların chat'ini kırar. Ayrı bir "global chat
--       hardening" adımı (M4) ile her mod kendi *_send_message RPC'sini
--       aldıktan sonra duel_messages lockdown'ı toplu yapılacak.
--   • duel_player_claims — M1 zaten doğru kurdu (INSERT-only policy, SELECT
--     grant'ı YOK, realtime publication DIŞI). Bu M3 ona dokunmaz.
--   • duel_group_* — kendi M1/M2/M3 setini ayrıca alacak.
--   • wheel_duel_*, wheel_group_*, conquest_* — zaten hardened.
--   • flag_duel_queue + flag_duel_quick_match / cancel RPC'leri.
--   • duel_rooms.room_source kolonu, indeksler, replica identity.
--   • supabase_realtime publication üyelikleri (duel_rooms, duel_players,
--     duel_claims, duel_messages — hepsi olduğu gibi kalır).
--   • Mevcut SATIRLAR (backfill yok; eski satırlar M1 öncesi profile_id/
--     guest_id NULL olarak kalır; yalnız okunabilir).
--   • Mevcut M2 RPC'lerinin signature ve gövdesi (yalnız policy değişiyor).
--   • cleanup_expired_duel_lobbies RPC.
--
-- DEĞİŞEN POLİTİKALAR
-- -------------------
--   duel_rooms:
--     SELECT  → herkes (realtime + davet linkiyle oda kodu lookup'ı için)
--     INSERT  → policy YOK → tek yol duel_create_room + duel_accept_rematch RPC
--     UPDATE  → policy YOK → tek yol M2 RPC'leri (start/finish/forfeit/...)
--     DELETE  → policy YOK → tek yol duel_leave_room RPC
--   duel_players:
--     SELECT  → herkes (lobi listesi, opponent monitor, score read için)
--     INSERT  → kısıtlı defansif: profile_id = auth.uid() VEYA
--               (profile_id NULL ve guest_id dolu). Pratikte SECURITY DEFINER
--               RPC'leri bu policy'i bypass eder; defense-in-depth amaçlı.
--     UPDATE  → policy YOK → tek yol duel_heartbeat RPC
--     DELETE  → policy YOK → tek yol duel_leave_room RPC (cascade dahil)
--   duel_claims:
--     SELECT  → herkes (realtime claim INSERT'leri ve final score freeze için)
--     INSERT  → policy YOK → tek yol duel_submit_claim RPC
--     UPDATE  → policy YOK (claim'ler immutable)
--     DELETE  → policy YOK (claim'ler immutable; cascade ile silinir)
--
-- TEMİZLEME STRATEJİSİ
-- --------------------
-- Studio'da elle kurulmuş eski policy'lerin isimleri kesin bilinmiyor (DuelGame
-- başındaki SQL örnekleri "anon_insert_*", wheel pattern'i "_anon" / "_all"
-- son ekli). Bu yüzden iki kademeli temizleme yapıyoruz:
--   (a) Bilinen aday isimleri "drop policy if exists" ile temizle (idempotent
--       re-run için stabil ve okunabilir).
--   (b) DO block ile kalan TÜM INSERT/UPDATE/DELETE policy'lerini dinamik drop
--       et (Studio'daki unknown isimleri yakalamak için defansif net).
-- SELECT policy'lerine dokunmuyoruz; sonunda kendi `*_select_public`
-- politikamızı yarat — varsa eski SELECT policy'leri ile birlikte aktif kalır
-- (OR semantiği zaten geniş; problem yok).
--
-- CANLI ODA / MID-FLIGHT ETKİSİ
-- ------------------------------
--   • Frontend FE switch tamamlandı → tüm modern client'lar RPC kullanıyor.
--   • Eski deploy cached JS hâlâ açık sekmede çalışıyorsa, direkt INSERT/
--     UPDATE/DELETE'leri RLS default-deny tarafından reddedilir. Kullanıcı
--     sayfayı reload edince yeni JS yüklenir. Bu, conquest + wheel_duel +
--     wheel_group hardening'lerinde kabul edilen bilinçli takasın aynısı.
--   • Mid-flight bir maçta: aktif RPC çağrıları M2 fonksiyonlarından geçtiği
--     için SECURITY DEFINER ile RLS bypass eder → maç bozulmaz.
--   • DuelGame.tsx country quick match: M2 RPC seti içinde dedicated bir
--     duel_quick_match RPC yok. FE switch'te quickMatch akışı, mevcut client-
--     side matchmaking (read-only SELECT) + duel_create_room + duel_join_room
--     RPC kombinasyonuna refactor edildi. Joiner artık status='playing' UPDATE
--     atmaz; host realtime'da 2. player'ı görünce duel_start_game RPC'sini
--     çağırır. Bu yüzden lockdown sonrası QM akışı bozulmaz.
--   • Rakibin oyun sırasında "leave" yapması ile tetiklenen eski "Opponent
--     left → forfeit" direct UPDATE fallback'i FE switch'te kaldırıldı. Bu
--     senaryo artık handleOppDisconnect → duel_handle_disconnect RPC ile
--     (45 + GRACE sn threshold) bitiriliyor; ek RPC gerekmiyor.
--
-- TEHDİT MODELİ ÖZETİ
-- -------------------
--   • anon-key sahibi 3. parti artık doğrudan:
--       - Başka odanın status / finished_reason / winner_player_id /
--         forfeited_player_id / disconnected_player_id / started_at /
--         rematch_room_id alanlarını yazamaz
--       - Bir oyuncunun last_seen_at'ini güncelleyemez (heartbeat spoof yok)
--       - Sahte duel_claims insert ile skor üretemez
--       - Başkasının player satırını silemez
--       - Başkasının odasını silemez
--   • Tüm yazımlar M2 RPC'leri üzerinden gider; her RPC'de
--     duel_authorize_player / duel_authorize_host claim_token veya auth.uid()
--     kanıtı zorunlu.
--   • duel_submit_claim sunucu tarafı player_room_mismatch + status='playing'
--     guard'ları ile spoof'a karşı sağlam.
--   • Misafir kimliği localStorage'daki claim_token'a bağlı; sekme temizliğiyle
--     kanıt kaybı kabul edilen takastır (Conquest / Wheel Duel ile aynı).
--
-- IDEMPOTENT
-- ----------
--   • Tüm policy işlemleri "drop policy if exists" + "create policy". DO block
--     dinamik drop'ları da existence-check sonrası çalışır. Migration tekrar
--     koşulursa hata vermez.
--
-- ROLLBACK
-- --------
-- Aşağıdaki SQL bloku canlı ortamda M3 hatası saptanırsa eski geniş policy'leri
-- geri açar (acil revert; M2 RPC'leri etkilenmez). DEFAULT olarak ÇALIŞTIRILMAZ;
-- yalnız manuel kopyala-yapıştır ile.
--
--   -- ROLLBACK ───────────────────────────────────────────────────────────
--   -- SELECT policy'leri zaten korunmuştu; yalnız INSERT/UPDATE/DELETE'i geri
--   -- açıyoruz. Bu DuelGame'in eski (FE switch öncesi) direct-write yollarını
--   -- yeniden çalıştırır; M2 RPC'leri RLS bypass ile bu policy'lerden bağımsız
--   -- çalışmaya devam eder.
--   create policy "duel_rooms_insert_anon"  on public.duel_rooms
--     for insert to anon, authenticated with check (true);
--   create policy "duel_rooms_update_anon"  on public.duel_rooms
--     for update to anon, authenticated using (true) with check (true);
--   create policy "duel_rooms_delete_anon"  on public.duel_rooms
--     for delete to anon, authenticated using (true);
--
--   drop policy if exists "duel_players_insert_self" on public.duel_players;
--   create policy "duel_players_insert_anon" on public.duel_players
--     for insert to anon, authenticated with check (true);
--   create policy "duel_players_update_anon" on public.duel_players
--     for update to anon, authenticated using (true) with check (true);
--   create policy "duel_players_delete_anon" on public.duel_players
--     for delete to anon, authenticated using (true);
--
--   create policy "duel_claims_insert_anon" on public.duel_claims
--     for insert to anon, authenticated with check (true);
--   -- duel_claims UPDATE/DELETE'i eski şemada da yoktu, gerekirse ekleyin.
--   -- ROLLBACK SONU ──────────────────────────────────────────────────────
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_rooms — INSERT/UPDATE/DELETE policy'lerini kaldır, SELECT bırak
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bilinen aday eski policy isimleri (DuelGame.tsx başındaki SQL örneği
--     + wheel pattern'i)
drop policy if exists "anon_insert_rooms"        on public.duel_rooms;
drop policy if exists "anon_update_rooms"        on public.duel_rooms;
drop policy if exists "anon_delete_rooms"        on public.duel_rooms;
drop policy if exists "duel_rooms_insert_anon"   on public.duel_rooms;
drop policy if exists "duel_rooms_update_anon"   on public.duel_rooms;
drop policy if exists "duel_rooms_delete_anon"   on public.duel_rooms;
drop policy if exists "duel_rooms_all_anon"      on public.duel_rooms;
drop policy if exists "Enable insert for anon"   on public.duel_rooms;
drop policy if exists "Enable update for anon"   on public.duel_rooms;
drop policy if exists "Enable delete for anon"   on public.duel_rooms;
-- Re-run idempotency:
drop policy if exists "duel_rooms_select_public" on public.duel_rooms;

-- (b) Defansif: kalan TÜM INSERT/UPDATE/DELETE policy'lerini dinamik drop et
do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_rooms'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format(
      'drop policy if exists %I on public.duel_rooms',
      pol.policyname
    );
  end loop;
end$$;

-- RLS açık olduğundan emin ol (Studio'da kapalı kurulmuş olsaydı bile)
alter table public.duel_rooms enable row level security;

-- SELECT: herkes (realtime + invite-link oda kodu lookup için zorunlu)
create policy "duel_rooms_select_public"
  on public.duel_rooms
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → RLS default-deny → tüm doğrudan client write'ları reddedilir.
-- → Yazma yolu: duel_create_room, duel_join_room, duel_start_game,
--   duel_finish_game, duel_forfeit_game, duel_handle_disconnect,
--   duel_accept_rematch, duel_join_rematch_room, duel_leave_room RPC'leri
--   (M2; hepsi SECURITY DEFINER).


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_players — INSERT defansif kalsın; UPDATE/DELETE policy YOK
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "anon_insert_players"       on public.duel_players;
drop policy if exists "anon_update_players"       on public.duel_players;
drop policy if exists "anon_delete_players"       on public.duel_players;
drop policy if exists "duel_players_insert_anon"  on public.duel_players;
drop policy if exists "duel_players_update_anon"  on public.duel_players;
drop policy if exists "duel_players_delete_anon"  on public.duel_players;
drop policy if exists "duel_players_all_anon"     on public.duel_players;
drop policy if exists "Enable insert for anon"    on public.duel_players;
drop policy if exists "Enable update for anon"    on public.duel_players;
drop policy if exists "Enable delete for anon"    on public.duel_players;
-- Re-run idempotency:
drop policy if exists "duel_players_select_public" on public.duel_players;
drop policy if exists "duel_players_insert_self"   on public.duel_players;

-- Defansif: kalan tüm INSERT/UPDATE/DELETE policy'lerini drop et
do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_players'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format(
      'drop policy if exists %I on public.duel_players',
      pol.policyname
    );
  end loop;
end$$;

alter table public.duel_players enable row level security;

-- SELECT: herkes (player listesi, opponent monitor için zorunlu)
create policy "duel_players_select_public"
  on public.duel_players
  for select
  to anon, authenticated
  using (true);

-- INSERT defansif: pratikte duel_create_room / duel_join_room /
-- duel_join_rematch_room / duel_accept_rematch RPC'leri SECURITY DEFINER ile
-- bypass eder. Bu policy yalnız RPC-dışı INSERT'lere karşı defense-in-depth:
--   - Logged-in: profile_id zorunlu, auth.uid() ile eşleşmeli
--   - Misafir:   profile_id NULL, guest_id dolu olmalı
create policy "duel_players_insert_self"
  on public.duel_players
  for insert
  to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- KASITLI: UPDATE / DELETE policy YOK.
-- → duel_heartbeat (last_seen_at) ve duel_leave_room (kendi satırı + cascade)
--   M2 RPC'leri SECURITY DEFINER ile bypass eder.


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_claims — INSERT/UPDATE/DELETE policy'lerini kaldır, SELECT bırak
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "anon_insert_claims"       on public.duel_claims;
drop policy if exists "anon_update_claims"       on public.duel_claims;
drop policy if exists "anon_delete_claims"       on public.duel_claims;
drop policy if exists "duel_claims_insert_anon"  on public.duel_claims;
drop policy if exists "duel_claims_update_anon"  on public.duel_claims;
drop policy if exists "duel_claims_delete_anon"  on public.duel_claims;
drop policy if exists "duel_claims_all_anon"     on public.duel_claims;
drop policy if exists "Enable insert for anon"   on public.duel_claims;
-- Re-run idempotency:
drop policy if exists "duel_claims_select_public" on public.duel_claims;

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_claims'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format(
      'drop policy if exists %I on public.duel_claims',
      pol.policyname
    );
  end loop;
end$$;

alter table public.duel_claims enable row level security;

-- SELECT: herkes (realtime claim INSERT akışı + final score freeze fetch için)
create policy "duel_claims_select_public"
  on public.duel_claims
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → INSERT tek yolu duel_submit_claim RPC (server-side player_room_mismatch +
--   status='playing' + UNIQUE(room_id, country_code) atomik guard).
-- → UPDATE/DELETE: claim'ler immutable; oda DELETE'iyle cascade temizlenir.


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_messages — KASITLI ÇIKARILDI
-- ----------------------------------------------------------------------------
-- duel_messages tablosu conquest / wheel_group / wheel_duel / flag_duel /
-- duel_group LobbyChat'i tarafından paylaşımlı kullanılıyor. Duel 1v1 chat
-- akışı duel_send_message RPC'ye geçti, fakat diğer modlar HÂLÂ doğrudan
-- duel_messages.insert atıyor. Bu tabloya bu M3'te dokunmak diğer modların
-- chat'ini kırar. Global chat hardening (M4) ile her mod kendi *_send_message
-- RPC'sini aldıktan sonra duel_messages lockdown'ı toplu yapılacak.
-- ────────────────────────────────────────────────────────────────────────────
-- (no-op)


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_player_claims — M1 KORUNUR
-- ----------------------------------------------------------------------------
-- M1 (20260603120000) duel_player_claims tablosunu zaten doğru kurdu:
--   • RLS açık
--   • INSERT-only policy ("duel_player_claims_insert", anon+authenticated)
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
--   --   duel_rooms        → duel_rooms_select_public          (SELECT)
--   --   duel_players      → duel_players_select_public        (SELECT)
--   --                     → duel_players_insert_self          (INSERT)
--   --   duel_claims       → duel_claims_select_public         (SELECT)
--   --   duel_player_claims→ duel_player_claims_insert         (INSERT) [M1]
--   --   duel_messages     → (Studio'daki mevcut policy'ler — DOKUNULMADI)
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in (
--        'duel_rooms', 'duel_players', 'duel_claims',
--        'duel_player_claims', 'duel_messages'
--      )
--    order by tablename, cmd, policyname;
--
--   -- duel_rooms/players/claims'de INSERT/UPDATE/DELETE policy KALMAMALI
--   -- (duel_players_insert_self hariç):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_rooms', 'duel_players', 'duel_claims')
--      and cmd in ('INSERT', 'UPDATE', 'DELETE')
--      and policyname <> 'duel_players_insert_self';
--   -- Beklenen: 0 satır
--
--   -- RLS açık mı?
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('duel_rooms', 'duel_players', 'duel_claims');
--   -- Beklenen: 3 satır, relrowsecurity=true.
--
--   -- Negatif test (anon JWT ile psql veya sql editor üzerinde):
--   --   insert into public.duel_rooms (code, status, duration_seconds, region)
--   --     values ('TEST01','waiting',60,'world');
--   --   → "new row violates row-level security policy" hatası beklenir.
--   --   update public.duel_rooms set status='finished' where id='<X>';
--   --   → reddedilmeli.
--   --   delete from public.duel_rooms where id='<X>';
--   --   → reddedilmeli.
--   --   insert into public.duel_claims (room_id, player_id, country_code)
--   --     values ('<R>', '<P>', 'TUR');
--   --   → reddedilmeli.
--   --   update public.duel_players set last_seen_at=now() where id='<P>';
--   --   → reddedilmeli.
--
--   -- M2 RPC'leri hâlâ çalışmalı (smoke, uygun parametrelerle):
--   --   select * from public.duel_create_room(...);
--   --   select public.duel_submit_claim(...);
--   --   → başarılı dönmeli (claim_token + identity doğru ise).
-- ============================================================================
