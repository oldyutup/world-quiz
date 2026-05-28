-- ============================================================================
-- M-Chat-B: Global Chat — duel_messages tablosu lockdown (Dilim 2)
-- ============================================================================
-- AMAÇ
--   M-Chat-A (20260614120000_global_chat_send_message_rpcs.sql) ile 5 modun
--   da kendi *_send_message RPC'si eklendi ve frontend tüm chat call-site'ları
--   RPC'ye geçti (LobbyChat + DuelGame/FlagDuelGame/WheelDuelGame/WheelGroupGame/
--   DuelGroupGame/ConquestGame). Artık duel_messages tablosunun direkt
--   INSERT/UPDATE/DELETE yolunu kapatıyoruz:
--     • Mevcut geniş INSERT/UPDATE/DELETE policy'leri (Studio'da elle
--       kurulmuş) ve "FOR ALL" türevleri DROP edilir.
--     • anon + authenticated rollerinden INSERT/UPDATE/DELETE GRANT'ları
--       REVOKE edilir.
--     • SELECT açık kalır → history load + realtime broadcast bozulmaz.
--     • Tablo RLS açık.
--
--   Yazma yolu yalnız 6 SECURITY DEFINER RPC üzerinden mümkün:
--     duel_send_message, flag_duel_send_message, wheel_duel_send_message,
--     wheel_group_send_message, duel_group_send_message, conquest_send_message.
--   SECURITY DEFINER fonksiyonları owner (postgres) rolünde koştuğu için hem
--   RLS hem rol GRANT'larını bypass eder → mesaj insert çalışmaya devam eder.
--
-- DOKUNULMAYAN ŞEYLER
--   • Send-message RPC'lerinin gövdesi / signature'ı (M-Chat-A).
--   • Diğer hardened tablolar (duel_rooms / duel_players / duel_claims /
--     wheel_*, conquest_*, flag_duel_*, duel_group_*).
--   • Frontend / call-site'lar.
--   • supabase_realtime publication üyelikleri (duel_messages dahil → SELECT
--     açık olduğu için realtime payload anon'a yine ulaşır).
--   • duel_messages tablosunun şeması, indeksleri, mevcut satırları.
--
-- TEMİZLEME STRATEJİSİ
--   M3 lockdown'larındaki ile aynı iki kademeli temizlik:
--     (a) Bilinen aday isimleri "drop policy if exists" ile sil
--         (Studio'daki standart isimler + wheel/duel hardening pattern'leri).
--     (b) DO block ile kalan TÜM INSERT/UPDATE/DELETE policy'lerini dinamik
--         drop et (yakalanmayan isimler için defansif net).
--   SELECT policy'leri korunur. Sonunda kendi "duel_messages_select_public"
--   policy'mizi (idempotent: önce drop, sonra create) kurarız; varsa diğer
--   eski SELECT policy'leri ile birlikte aktif kalabilir (OR semantiği,
--   problem yok).
--
-- CANLI ODA / MID-FLIGHT ETKİSİ
--   • FE switch tamamlandı → tüm modern client'lar RPC kullanıyor.
--   • Eski deploy cached JS hâlâ açık sekmede çalışıyorsa, direct insert
--     RLS default-deny + GRANT revoke ile reddedilir → kullanıcı reload
--     edince yeni JS yüklenir. Bilinçli takas (M-Chat-A kabul edilen
--     pattern'i).
--   • Aktif RPC çağrıları SECURITY DEFINER olduğu için bozulmaz.
--   • SELECT açık kalmaya devam ettiğinden mevcut history fetch + realtime
--     abonelikleri (postgres_changes / broadcast) etkilenmez.
--
-- TEHDİT MODELİ ÖZETİ
--   • anon-key sahibi 3. parti artık doğrudan:
--       - Başka oyuncunun adıyla duel_messages.insert atamaz
--         (player_name server-side resolve ediliyor, yetki claim_token
--          ile RPC içinde guard'lı).
--       - Yetkisi olmadığı odanın mesajlarını UPDATE veya DELETE edemez
--         (zaten policy/GRANT yok → default-deny).
--       - Cross-room spoof: RPC içinde room_code_mismatch guard'ı tutuyor.
--   • SELECT bilinçli olarak açık: bir oyuncu odasının kodunu biliyorsa
--     o odanın chat'ini okuyabilir. Bu, M-Chat-A pattern'inin kabul ettiği
--     ve odanın realtime broadcast'iyle zaten gözlemlenebilir bir takastır.
--
-- IDEMPOTENT
--   • "drop policy if exists" + "create policy" pattern'i.
--   • "revoke ... if exists" yok (Postgres'te REVOKE'lar zaten idempotent —
--     olmayan privilege REVOKE edilirse no-op).
--   • DO block dinamik drop'ları existence-check sonrası çalışır.
--   • Migration tekrar koşulursa hata vermez.
--
-- ROLLBACK
-- --------
-- Acil revert için aşağıdaki SQL bloğu eski geniş GRANT'ları ve "FOR ALL"
-- policy'sini geri kurar. DEFAULT olarak ÇALIŞTIRILMAZ; manuel kopyala-yapıştır
-- ile uygulanır. Send-message RPC'leri SECURITY DEFINER olduğu için bu
-- rollback'ten bağımsız çalışmaya devam eder.
--
--   -- ROLLBACK ───────────────────────────────────────────────────────────
--   grant insert, update, delete on public.duel_messages to anon, authenticated;
--
--   drop policy if exists "duel_messages_select_public" on public.duel_messages;
--   create policy "duel_messages_all_anon"
--     on public.duel_messages
--     for all
--     to anon, authenticated
--     using (true)
--     with check (true);
--   -- ROLLBACK SONU ──────────────────────────────────────────────────────
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Bilinen aday eski INSERT/UPDATE/DELETE/ALL policy isimleri
-- ----------------------------------------------------------------------------
-- Studio'da elle kurulmuş, conquest/wheel/duel hardening pattern'lerinde
-- görülen ve eski DuelGame.tsx SQL örneklerindeki isimler.
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "anon_insert_messages"          on public.duel_messages;
drop policy if exists "anon_update_messages"          on public.duel_messages;
drop policy if exists "anon_delete_messages"          on public.duel_messages;
drop policy if exists "anon_all_messages"             on public.duel_messages;
drop policy if exists "duel_messages_insert_anon"     on public.duel_messages;
drop policy if exists "duel_messages_update_anon"     on public.duel_messages;
drop policy if exists "duel_messages_delete_anon"     on public.duel_messages;
drop policy if exists "duel_messages_all_anon"        on public.duel_messages;
drop policy if exists "Enable insert for anon"        on public.duel_messages;
drop policy if exists "Enable update for anon"        on public.duel_messages;
drop policy if exists "Enable delete for anon"        on public.duel_messages;
drop policy if exists "Enable insert for all users"   on public.duel_messages;
drop policy if exists "Enable update for all users"   on public.duel_messages;
drop policy if exists "Enable delete for all users"   on public.duel_messages;
drop policy if exists "Enable read access for all"    on public.duel_messages;
-- Re-run idempotency: kendi SELECT policy'mizin önceki halini de temizle
drop policy if exists "duel_messages_select_public"   on public.duel_messages;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Defansif: kalan TÜM INSERT/UPDATE/DELETE policy'lerini dinamik drop et
-- ----------------------------------------------------------------------------
-- Studio'da bilinmeyen isimle kurulmuş ya da "FOR ALL" türevleri (cmd='ALL')
-- yakalanır. SELECT policy'lerine dokunulmaz.
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_messages'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  loop
    execute format(
      'drop policy if exists %I on public.duel_messages',
      pol.policyname
    );
  end loop;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) RLS açık olduğundan emin ol
-- ----------------------------------------------------------------------------
-- Studio'da kapalı kurulmuş olsa bile garanti altına alıyoruz. RLS açıkken
-- policy YOKsa default-deny.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_messages enable row level security;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) SELECT policy — herkes (history + realtime için zorunlu)
-- ----------------------------------------------------------------------------
-- anon + authenticated SELECT yapabilsin. Realtime postgres_changes +
-- LobbyChat history fetch bozulmasın.
-- ────────────────────────────────────────────────────────────────────────────

create policy "duel_messages_select_public"
  on public.duel_messages
  for select
  to anon, authenticated
  using (true);


-- ────────────────────────────────────────────────────────────────────────────
-- 5) GRANT lockdown — anon/authenticated için INSERT/UPDATE/DELETE revoke
-- ----------------------------------------------------------------------------
-- RLS default-deny zaten direct yazımları reddediyor; bu adım ikinci kat
-- defansif: rolün tablo üzerinde DML privilege'ı yoksa policy bile değerlendi-
-- rilmez. SECURITY DEFINER RPC'leri owner (postgres) rolünde çalıştığı için
-- bu REVOKE'lardan etkilenmez.
--
-- SELECT GRANT'ı KORUNUR — açık bırakıyoruz ki realtime + history sorgusu
-- çalışsın.
-- ────────────────────────────────────────────────────────────────────────────

revoke insert, update, delete on public.duel_messages from anon;
revoke insert, update, delete on public.duel_messages from authenticated;

-- SELECT GRANT'ının açık olduğundan emin ol (idempotent re-grant)
grant select on public.duel_messages to anon, authenticated;


-- ============================================================================
-- DOĞRULAMA SORGULARI (manuel; bu migration'ın parçası değil)
-- ----------------------------------------------------------------------------
--
--   -- Policy'ler: yalnız SELECT bekleniyor
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'duel_messages'
--    order by policyname;
--   -- Beklenen: bir satır → duel_messages_select_public, SELECT, {anon, authenticated}
--
--   -- Grant'lar: anon + authenticated için yalnız SELECT
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'duel_messages'
--      and grantee in ('anon', 'authenticated')
--    order by grantee, privilege_type;
--   -- Beklenen: 2 satır → (anon, SELECT) + (authenticated, SELECT).
--   --           INSERT/UPDATE/DELETE listede OLMAMALI.
--
--   -- RLS açık mı?
--   select relname, relrowsecurity
--     from pg_class
--    where relname = 'duel_messages';
--   -- Beklenen: relrowsecurity = true.
--
-- Smoke (manuel — frontend):
--   • Bir mod odasında mesaj at (LobbyChat) → karşıda gözüksün, DB satırı
--     player_name = sunucu tarafında çözülen ad olarak yazılı.
--   • DevTools console:
--       await supabase.from('duel_messages')
--         .insert({ room_code: 'XYZ', player_name: 'x', message: 'spoof' });
--     → error: "permission denied for table duel_messages" (42501).
--   • DevTools console:
--       await supabase.from('duel_messages')
--         .update({ message: 'tamper' }).eq('id', <bir id>);
--     → 0 satır etkilendi VEYA permission denied.
--   • DevTools console:
--       await supabase.from('duel_messages').delete().eq('id', <bir id>);
--     → 0 satır etkilendi VEYA permission denied.
--   • History fetch:
--       await supabase.from('duel_messages')
--         .select('*').eq('room_code', 'XYZ').order('created_at');
--     → mesajlar dönüyor, SELECT etkilenmemiş.
-- ============================================================================
