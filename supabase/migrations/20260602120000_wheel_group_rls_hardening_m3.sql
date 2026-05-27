-- ============================================================================
-- Wheel Group — RLS hardening · M3 (lockdown)
-- ============================================================================
-- AMAÇ
-- ----
-- M1 + M2 + frontend RPC switch tamamlandı ve canlıda test edildi. Artık eski
-- "_anon" geniş politikaları kaldırıyoruz; yazma yolu yalnızca M2 RPC'leri
-- (SECURITY DEFINER) üzerinden mümkün olacak. SELECT yetkileri korunur —
-- realtime abonelikleri, oda kodu lookup'ı ve lobi listesi için zorunlu.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_*
--   • wheel_duel_* (M1/M2/M3 ayrı, dokunulmuyor)
--   • flag_duel_queue / wheel_duel_queue
--   • conquest_*
--   • profiles, xp_events
--   • award_wheel_group_xp_event RPC
--   • wheel_group_check_capacity trigger (BEFORE INSERT)
--   • supabase_realtime publication üyelikleri
--   • Mevcut wheel_group_rooms / wheel_group_players SATIRLARI (backfill yok)
--   • wheel_group_player_claims tablosu, policy'si ve grant'leri (M1 koydu)
--   • M2 RPC'leri (signature ve gövde değişmez)
--
-- DEĞİŞEN POLİTİKALAR
-- -------------------
--   wheel_group_rooms:
--     SELECT  → herkes (eski davranış korunur; realtime + invite lookup için)
--     INSERT  → policy YOK   → reddedilir; tek yol wheel_group_create_room RPC
--     UPDATE  → policy YOK   → reddedilir; tek yol M2 RPC'leri
--     DELETE  → policy YOK   → reddedilir; tek yol wheel_group_leave_room RPC
--   wheel_group_players:
--     SELECT  → herkes (lobi + skorbord için)
--     INSERT  → kısıtlı defansif: profile_id = auth.uid() VEYA
--               (profile_id null ve guest_id dolu). Pratikte RPC tercih edilen
--               yol; bu policy yalnız RPC-dışı INSERT'lere karşı defense-in-depth.
--     UPDATE  → policy YOK   → reddedilir; tek yol M2 RPC'leri
--     DELETE  → policy YOK   → reddedilir; tek yol wheel_group_leave_room /
--               wheel_group_kick_player RPC
--
-- CANLI ODA / MID-FLIGHT ETKİSİ
-- ------------------------------
--   • Frontend switch zaten merge edildi → tüm modern client'lar RPC kullanıyor.
--   • Eski (önceki deploy) cached JS hâlâ açık sekmede çalışıyorsa, direkt
--     UPDATE/DELETE'leri RLS tarafından reddedilir. Bu, Conquest / Wheel Duel
--     hardening phase'lerinde kabul edilen bilinçli takasın aynısı: güvenlik
--     kazancı karşılığında eski sekmelerin yeniden yüklenmesi (F5).
--   • Mid-flight bir maçta: aktif RPC çağrıları M2 fonksiyonlarından geçtiği
--     için SECURITY DEFINER ile RLS bypass eder → maç bozulmaz.
--
-- TEHDİT MODELİ ÖZETİ (M3 sonrası kapanan vektörler)
-- --------------------------------------------------
--   • anon-key sahibi 3. parti artık doğrudan:
--       - Başka oyuncunun skorunu manipüle edemez (UPDATE deny).
--       - current_target_topoid / used_target_topoids gameplay alanlarını
--         yazamaz (UPDATE deny).
--       - host_player_id'yi hijack edemez (UPDATE deny).
--       - status'u 'finished' / 'playing' / 'waiting' arasında griefing
--         amaçlı flip edemez (UPDATE deny).
--       - duration_seconds / region / penalty_enabled / max_players ayarlarını
--         lobby dışından değiştiremez (UPDATE deny).
--       - current_match_id'yi rotate edip XP idempotency'sini bypass edemez
--         (UPDATE deny).
--       - Başka oyuncunun player satırını silemez / kickleyemez (DELETE deny).
--       - Sahte player INSERT'i ile odayı kirletemez (INSERT defensive
--         policy guest_id veya profile_id=auth.uid() zorunluluğu).
--       - Başka odanın satırını silemez (DELETE deny).
--   • Tüm yazımlar M2 RPC'leri üzerinden gider; her RPC'de
--     wheel_group_authorize_player / wheel_group_authorize_host claim_token
--     veya auth.uid() kanıtı zorunlu.
--   • Misafir kimliği localStorage'daki claim_token; sekme değişimi ile
--     kanıt kaybı kabul edilen takastır (Conquest / Wheel Duel ile aynı).
--   • DoS / kapasite doldurma vektörleri kapsam dışı; ileride INSERT
--     trigger-tabanlı rate-limit ile sertleştirilebilir.
--   • wheel_group_check_capacity trigger'ı INSERT defensive policy'sine ek
--     olarak hâlâ aktif → kapasite üst limiti her yoldan korunur.
--
-- IDEMPOTENT
-- ----------
--   • Tüm policy işlemleri "drop policy if exists" + (gerekiyorsa)
--     "create policy". Migration tekrar koşulursa hata vermez.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_group_rooms — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

-- Eski geniş "_anon" politikalarını düşür
drop policy if exists "wheel_group_rooms_select_all"  on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_insert_anon" on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_update_anon" on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_delete_anon" on public.wheel_group_rooms;
-- Yeniden çalıştırma çakışmasını da temizle
drop policy if exists "wheel_group_rooms_select_public" on public.wheel_group_rooms;

-- SELECT: herkes. Realtime abonelikleri ve davet linki ile oda kodu lookup'ı
-- bu policy'ye dayanır. SECURITY DEFINER RPC'leri zaten RLS bypass eder, bu
-- yüzden bu policy yalnız doğrudan SELECT yolları için anlamlıdır.
create policy "wheel_group_rooms_select_public"
  on public.wheel_group_rooms
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → RLS default-deny devreye girer → tüm doğrudan client write'ları reddedilir.
-- → Yazma yolu yalnız M2 RPC'leri (SECURITY DEFINER) üzerinden:
--      wheel_group_create_room       (INSERT)
--      wheel_group_join_room         (UPDATE updated_at)
--      wheel_group_start_game        (UPDATE status/started_at/...)
--      wheel_group_update_settings   (UPDATE settings)
--      wheel_group_pick_target       (UPDATE current_target_topoid)
--      wheel_group_claim_target      (UPDATE current_target_topoid/used_target_topoids)
--      wheel_group_finish_game       (UPDATE status/finished_at/finished_reason)
--      wheel_group_return_to_lobby   (UPDATE status reset)
--      wheel_group_leave_room        (UPDATE host_player_id veya DELETE room)


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_group_players — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

-- Eski geniş "_anon" politikalarını düşür
drop policy if exists "wheel_group_players_select_all"  on public.wheel_group_players;
drop policy if exists "wheel_group_players_insert_anon" on public.wheel_group_players;
drop policy if exists "wheel_group_players_update_anon" on public.wheel_group_players;
drop policy if exists "wheel_group_players_delete_anon" on public.wheel_group_players;
-- Yeniden çalıştırma çakışmasını da temizle
drop policy if exists "wheel_group_players_select_public" on public.wheel_group_players;
drop policy if exists "wheel_group_players_insert_self"   on public.wheel_group_players;

-- SELECT: herkes. Lobi player listesi, skorbord, realtime player UPDATE'leri
-- bu policy'ye dayanır.
create policy "wheel_group_players_select_public"
  on public.wheel_group_players
  for select
  to anon, authenticated
  using (true);

-- INSERT: kısıtlı defansif. Pratikte wheel_group_create_room ve
-- wheel_group_join_room RPC'leri SECURITY DEFINER ile bu policy'i bypass eder;
-- bu policy yalnız RPC-dışı INSERT'lere karşı defense-in-depth.
-- profile_id verilmişse auth.uid() ile eşleşmek ZORUNDA; misafir ise
-- guest_id dolu olmalı ve profile_id null kalmalı.
-- NOT: wheel_group_check_capacity trigger'ı bu policy'den BAĞIMSIZ çalışır
--      → kapasite üst limiti her INSERT yolunda korunur.
create policy "wheel_group_players_insert_self"
  on public.wheel_group_players
  for insert
  to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- KASITLI: UPDATE / DELETE policy YOK.
-- → RLS default-deny: doğrudan score yazımı, last_seen_at güncelleme, kendi
--    satırını silme gibi yollar reddedilir.
-- → Yazma yolu yalnız M2 RPC'leri (SECURITY DEFINER) üzerinden:
--      wheel_group_claim_target      (UPDATE score = score + 1)
--      wheel_group_start_game        (UPDATE score = 0 — round reset)
--      wheel_group_leave_room        (DELETE self veya cascade)
--      wheel_group_kick_player       (DELETE target)


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   -- Beklenen final policy listesi:
--   --   wheel_group_rooms         → wheel_group_rooms_select_public   (SELECT)
--   --   wheel_group_players       → wheel_group_players_select_public (SELECT)
--   --                             → wheel_group_players_insert_self   (INSERT)
--   --   wheel_group_player_claims → wheel_group_player_claims_insert  (INSERT) [M1]
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename like 'wheel_group_%'
--    order by tablename, cmd, policyname;
--
--   -- "_anon" policy KALMAMALI:
--   select count(*) as anon_policies_left
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_group_rooms', 'wheel_group_players')
--      and policyname like '%_anon';
--   -- Beklenen: 0
--
--   -- "_select_all" eski isim KALMAMALI:
--   select count(*) as legacy_select_all_left
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_group_rooms', 'wheel_group_players')
--      and policyname like '%_select_all';
--   -- Beklenen: 0
--
--   -- Negatif test (anon key ile psql veya sql editor üzerinde):
--   --   update public.wheel_group_rooms set status = 'finished' where id = 'X';
--   --   → "new row violates row-level security policy" hatası beklenir.
--   --   delete from public.wheel_group_rooms where id = 'X';
--   --   → reddedilmeli.
--   --   update public.wheel_group_players set score = 999 where id = 'Y';
--   --   → reddedilmeli.
--   --   delete from public.wheel_group_players where id = 'Y';
--   --   → reddedilmeli.
--   --   insert into public.wheel_group_players (id, room_id, name)
--   --     values (gen_random_uuid(), 'X', 'attacker');
--   --   → profile_id null + guest_id null olduğu için reddedilmeli.
--
--   -- M2 RPC'leri hâlâ çalışıyor mu? (smoke):
--   --   select public.wheel_group_create_room(...);
--   --   → başarılı dönmeli (uygun parametrelerle).
--
-- ============================================================================
-- ROLLBACK (acil durum — eski geniş "_anon" davranışını geri yükler)
-- ============================================================================
-- Aşağıdaki SQL ayrı bir migration dosyası olarak çalıştırılırsa M3
-- öncesi davranışa geri döner. M2 RPC'leri ve M1 altyapısı yerinde kalır
-- (onlar additive); yalnız RLS politikaları eski geniş hâline çekilir.
-- Bu SQL **dokümantasyon amaçlı yorum**; otomatik çalıştırılmaz.
--
-- -- 1) Yeni sıkı politikaları düşür
-- drop policy if exists "wheel_group_rooms_select_public"   on public.wheel_group_rooms;
-- drop policy if exists "wheel_group_players_select_public" on public.wheel_group_players;
-- drop policy if exists "wheel_group_players_insert_self"   on public.wheel_group_players;
--
-- -- 2) Eski geniş "_anon" politikalarını yeniden kur (init migration kopyası)
-- create policy "wheel_group_rooms_select_all"
--   on public.wheel_group_rooms for select
--   to anon, authenticated using (true);
-- create policy "wheel_group_rooms_insert_anon"
--   on public.wheel_group_rooms for insert
--   to anon, authenticated with check (true);
-- create policy "wheel_group_rooms_update_anon"
--   on public.wheel_group_rooms for update
--   to anon, authenticated using (true) with check (true);
-- create policy "wheel_group_rooms_delete_anon"
--   on public.wheel_group_rooms for delete
--   to anon, authenticated using (true);
--
-- create policy "wheel_group_players_select_all"
--   on public.wheel_group_players for select
--   to anon, authenticated using (true);
-- create policy "wheel_group_players_insert_anon"
--   on public.wheel_group_players for insert
--   to anon, authenticated with check (true);
-- create policy "wheel_group_players_update_anon"
--   on public.wheel_group_players for update
--   to anon, authenticated using (true) with check (true);
-- create policy "wheel_group_players_delete_anon"
--   on public.wheel_group_players for delete
--   to anon, authenticated using (true);
--
-- -- 3) Doğrula
-- -- select tablename, policyname, cmd from pg_policies
-- --  where schemaname = 'public' and tablename like 'wheel_group_%'
-- --  order by tablename, cmd, policyname;
-- ============================================================================
