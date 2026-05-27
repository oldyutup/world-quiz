-- ============================================================================
-- Wheel Duel — RLS hardening · M3 (lockdown)
-- ============================================================================
-- AMAÇ
-- ----
-- M1 + M2 + frontend RPC switch tamamlandı. Artık eski "_anon" geniş
-- politikaları kaldırıyoruz; yazma yolu yalnızca M2 RPC'leri (SECURITY DEFINER)
-- üzerinden mümkün olacak. SELECT yetkileri korunur — realtime abonelikleri,
-- oda kodu lookup'ı ve lobi listesi için zorunlu.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_*
--   • wheel_group_*
--   • flag_duel_queue / wheel_duel_queue (quick match queue tabloları)
--   • wheel_duel_quick_match / wheel_duel_cancel_quick_match RPC'leri
--   • conquest_*
--   • profiles, xp_events
--   • supabase_realtime publication üyelikleri
--   • Mevcut wheel_duel_rooms / wheel_duel_players SATIRLARI (backfill yok)
--   • wheel_duel_player_claims tablosu, policy'si ve grant'leri (M1 koydu)
--   • M2 RPC'leri (signature ve gövde değişmez)
--
-- DEĞİŞEN POLİTİKALAR
-- -------------------
--   wheel_duel_rooms:
--     SELECT  → herkes (eski davranış korunur; realtime + invite lookup için)
--     INSERT  → policy YOK   → reddedilir; tek yol wheel_duel_create_room RPC
--     UPDATE  → policy YOK   → reddedilir; tek yol M2 RPC'leri
--     DELETE  → policy YOK   → reddedilir; tek yol wheel_duel_leave_room RPC
--   wheel_duel_players:
--     SELECT  → herkes (lobi + skorbord için)
--     INSERT  → kısıtlı defansif: profile_id = auth.uid() VEYA
--               (profile_id null ve guest_id dolu). Pratikte RPC tercih edilen
--               yol; bu policy yalnız RPC-dışı INSERT'lere karşı defense-in-depth.
--     UPDATE  → policy YOK   → reddedilir; tek yol M2 RPC'leri
--     DELETE  → policy YOK   → reddedilir; tek yol wheel_duel_leave_room RPC
--
-- CANLI ODA / MID-FLIGHT ETKİSİ
-- ------------------------------
--   • Frontend switch zaten merge edildi → tüm modern client'lar RPC kullanıyor.
--   • Eski (önceki deploy) cached JS hâlâ açık sekmede çalışıyorsa, direkt
--     UPDATE/DELETE'leri RLS tarafından reddedilir. Bu, Conquest hardening
--     phase'inde kabul edilen bilinçli takasın aynısı: güvenlik kazancı
--     karşılığında eski sekmelerin yeniden yüklenmesi.
--   • Mid-flight bir maçta: aktif RPC çağrıları M2 fonksiyonlarından geçtiği
--     için SECURITY DEFINER ile RLS bypass eder → maç bozulmaz.
--   • Quick match: wheel_duel_quick_match RPC'sinin SECURITY DEFINER OLDUĞU
--     varsayılır (flag_duel_queue_lockdown ile aynı pattern). Eğer değilse,
--     o RPC'nin oda/player INSERT'leri bu lockdown sonrasında reddedilir.
--     Quick match smoke test'i deploy sonrası gözlenmeli.
--
-- TEHDİT MODELİ ÖZETİ
-- -------------------
--   • anon-key sahibi 3. parti artık doğrudan:
--       - Başka odanın gameplay alanlarını yazamaz (current_target, used, pass*,
--         rematch*, status, winner_player_id, started_at, finished_*)
--       - Bir oyuncunun skorunu manipüle edemez
--       - Sahte player INSERT'i ile odayı kirletemez (guest_id zorunluluğu)
--       - Başka odanın satırını silemez
--   • Tüm yazımlar M2 RPC'leri üzerinden gider; her RPC'de
--     wheel_duel_authorize_player / wheel_duel_authorize_host claim_token
--     veya auth.uid() kanıtı zorunlu.
--   • Misafir kimliği localStorage'daki claim_token; sekme değişimi ile
--     kanıt kaybı kabul edilen takastır (Conquest ile aynı).
--   • DoS / kapasite doldurma vektörleri kapsam dışı; ileride INSERT
--     trigger-tabanlı rate-limit ile sertleştirilebilir.
--
-- IDEMPOTENT
-- ----------
--   • Tüm policy işlemleri "drop policy if exists" + (gerekiyorsa)
--     "create policy". Migration tekrar koşulursa hata vermez.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_duel_rooms — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

-- Eski geniş "_anon" politikalarını düşür
drop policy if exists "wheel_rooms_select_all"  on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_insert_anon" on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_update_anon" on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_delete_anon" on public.wheel_duel_rooms;
-- Yeniden çalıştırma çakışmasını da temizle
drop policy if exists "wheel_duel_rooms_select_public" on public.wheel_duel_rooms;

-- SELECT: herkes. Realtime abonelikleri ve davet linki ile oda kodu lookup'ı
-- bu policy'ye dayanır. SECURITY DEFINER RPC'leri zaten RLS bypass eder, bu
-- yüzden bu policy yalnız doğrudan SELECT yolları için anlamlıdır.
create policy "wheel_duel_rooms_select_public"
  on public.wheel_duel_rooms
  for select
  to anon, authenticated
  using (true);

-- KASITLI: INSERT / UPDATE / DELETE policy YOK.
-- → RLS default-deny devreye girer → tüm doğrudan client write'ları reddedilir.
-- → Yazma yolu yalnız wheel_duel_create_room, wheel_duel_join_room,
--    wheel_duel_start_game, wheel_duel_update_settings, wheel_duel_pick_target,
--    wheel_duel_finish_game, wheel_duel_request_pass, wheel_duel_process_skip,
--    wheel_duel_request_rematch, wheel_duel_process_rematch,
--    wheel_duel_leave_room RPC'leri (M2; hepsi SECURITY DEFINER) üzerinden.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_duel_players — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

-- Eski geniş "_anon" politikalarını düşür
drop policy if exists "wheel_players_select_all"  on public.wheel_duel_players;
drop policy if exists "wheel_players_insert_anon" on public.wheel_duel_players;
drop policy if exists "wheel_players_update_anon" on public.wheel_duel_players;
drop policy if exists "wheel_players_delete_anon" on public.wheel_duel_players;
-- Yeniden çalıştırma çakışmasını da temizle
drop policy if exists "wheel_duel_players_select_public" on public.wheel_duel_players;
drop policy if exists "wheel_duel_players_insert_self"   on public.wheel_duel_players;

-- SELECT: herkes. Lobi player listesi, skorbord, realtime player UPDATE'leri
-- bu policy'ye dayanır.
create policy "wheel_duel_players_select_public"
  on public.wheel_duel_players
  for select
  to anon, authenticated
  using (true);

-- INSERT: kısıtlı defansif. Pratikte wheel_duel_create_room ve
-- wheel_duel_join_room RPC'leri SECURITY DEFINER ile bu policy'i bypass eder;
-- bu policy yalnız RPC-dışı INSERT'lere karşı defense-in-depth.
-- profile_id verilmişse auth.uid() ile eşleşmek ZORUNDA; misafir ise
-- guest_id dolu olmalı ve profile_id null kalmalı.
create policy "wheel_duel_players_insert_self"
  on public.wheel_duel_players
  for insert
  to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- KASITLI: UPDATE / DELETE policy YOK.
-- → RLS default-deny: doğrudan score yazımı, last_seen_at güncelleme, kendi
--    satırını silme gibi yollar reddedilir.
-- → Yazma yolu: wheel_duel_claim_target (skor +1), wheel_duel_process_rematch
--    (skor reset), wheel_duel_leave_room (kendi satırı DELETE), ve oda DELETE
--    sırasında cascade. Hepsi M2 RPC'lerinde SECURITY DEFINER ile.


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   -- Beklenen final policy listesi:
--   --   wheel_duel_rooms   → wheel_duel_rooms_select_public (SELECT)
--   --   wheel_duel_players → wheel_duel_players_select_public (SELECT)
--   --                      → wheel_duel_players_insert_self   (INSERT)
--   --   wheel_duel_player_claims → wheel_duel_player_claims_insert (INSERT) [M1]
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename like 'wheel_duel_%'
--    order by tablename, cmd, policyname;
--
--   -- "_anon" policy KALMAMALI:
--   select count(*) as anon_policies_left
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_duel_rooms', 'wheel_duel_players')
--      and policyname like '%_anon';
--   -- Beklenen: 0
--
--   -- Negatif test (anon key ile psql veya sql editor üzerinde):
--   --   update public.wheel_duel_rooms set status = 'finished' where id = 'X';
--   --   → "new row violates row-level security policy" hatası beklenir.
--   --   delete from public.wheel_duel_rooms where id = 'X';
--   --   → reddedilmeli.
--   --   update public.wheel_duel_players set score = 999 where id = 'Y';
--   --   → reddedilmeli.
--
--   -- M2 RPC'leri hâlâ çalışıyor mu? (smoke):
--   --   select public.wheel_duel_create_room(...);
--   --   → başarılı dönmeli (uygun parametrelerle).
-- ============================================================================
