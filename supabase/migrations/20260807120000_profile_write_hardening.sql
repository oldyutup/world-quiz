-- ============================================================================
-- PROFILES YAZMA SERTLEŞTİRME — sunucu-otoriter kolonların ACL kilidi
-- ============================================================================
-- BAĞIMLILIK: 20260806120000_ugc_safety_reports_moderation.sql (moderation_status
--   / suspended_until kolonlarını + _profiles_ugc_enforce trigger'ını ekler). Bu
--   migration ONDAN SONRA çalışır ve o kolonları da ACL katmanında kilitler.
--
-- KANITLANAN AÇIK (canlı prod schema dump + izole runtime ile doğrulandı):
--   public.profiles üzerinde tablo-seviyesi 'GRANT ALL ... TO anon, authenticated'
--   var. PostgreSQL'de tablo-seviyesi UPDATE grant'ı varken KOLON-seviyesi
--   'REVOKE UPDATE (col)' NO-OP'tur. RLS "Users can update own profile"
--   (USING auth.uid()=id) kendi satırına yazmaya izin verdiğinden, authenticated
--   bir kullanıcı KENDİ JWT'siyle doğrudan REST UPDATE ile:
--       update public.profiles set gold = 999999 where id = <kendi id>;
--   yaparak gold/xp/level gibi SUNUCU-OTORİTER ekonomiyi şişirebiliyordu.
--   (Aynı desen moderation_status için self-unban açığı oluşturmuştu; UGC
--    migration'ında trigger ile kapatıldı. Ekonomi/ilerleme/sistem kolonları
--    için GERÇEK çözüm ACL seviyesinde BURADA yapılır.)
--
-- ÇÖZÜM (least-privilege, ACL-katmanı — trigger'a bağlı değil):
--   1) profiles üzerindeki tablo-seviyesi TÜM yazma yetkisi anon+authenticated'dan
--      geri alınır (REVOKE ALL). Dünya-okunur olması için SELECT geri verilir.
--   2) authenticated'a YALNIZ gerçekten kullanıcı-editable kolonlarda kolon-
--      seviyesi UPDATE/INSERT verilir. Böylece column-level grant tablo-level
--      grant'ı GÖLGELEMEZ; has_column_privilege gerçekten uygulanır.
--   3) anon'a HİÇBİR yazma yetkisi kalmaz (yalnız SELECT).
--   4) service_role (GRANT ALL, bypassrls) ve owner postgres DOKUNULMAZ →
--      meşru SECURITY DEFINER ekonomi/ilerleme RPC'leri (hepsi owner=postgres)
--      çalışmaya devam eder. Kanıt: profiles'a yazan 6 fonksiyonun TAMAMI
--      SECURITY DEFINER (0 INVOKER): _apply_gold_delta, award_xp_event(→),
--      change_username, claim_achievement_rewards, claim_daily_gold_bonus,
--      daily_quest_claim_reward, respond_friend_request.
--
-- KULLANICI-EDITABLE kolonlar (authenticated doğrudan yazabilir):
--   username              — içerik filtresi trg_profiles_ugc_enforce'da zorlanır
--   avatar_id             — format CHECK (profiles_avatar_id_format_chk) backstop
--   username_normalized   — trg_sync_username_normalized DAİMA username_key(username)
--                           ile ÜZERİNE YAZAR → istemci değeri zehirleyemez
--   has_chosen_username   — düşük hassasiyet onboarding bayrağı (çapraz-kullanıcı yok)
--   username_source       — düşük hassasiyet audit metni
--   updated_at            — kozmetik zaman damgası; hiçbir güvenlik mantığı buna bağlı
--                           değil (client updateUsername/updateAvatar bunu yazar)
--
-- SUNUCU-OTORİTER kolonlar (authenticated YAZAMAZ — yalnız DEFINER RPC / postgres):
--   gold, xp, level                         — ekonomi + ilerleme  (KANITLANAN AÇIK)
--   created_at                              — değişmez oluşturma zamanı
--   is_test_account                         — leaderboard gizleme sistem bayrağı
--   username_changed_at, username_change_count — change_username RPC guard'ları
--   profile_code                            — trg_assign_profile_code ile sunucu üretir
--   moderation_status, suspended_until      — moderasyon (UGC)
--   id                                      — değişmez PK (UPDATE'te verilmez;
--                                             INSERT'te client kendi auth.uid()'sini verir)
--
-- IDEMPOTENT: REVOKE/GRANT tekrar çalıştırılabilir. Canlı VERİYİ DEĞİŞTİRMEZ
-- (yalnız katalog ACL'i). Elle (Supabase Studio SQL editor, postgres bağlamı)
-- uygulanabilir. Deploy sırası: ÖNCE 20260806120000, SONRA bu dosya.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TABLO-SEVİYESİ YAZMA YETKİSİNİ KALDIR (GRANT ALL tabanından yalnız YAZMA)
-- ----------------------------------------------------------------------------
-- SELECT'e DOKUNMADAN yalnız yazma privilege'larını geri al. Böylece canlı
-- uygulamada dünya-okunurlukta (leaderboard / public profil kartı) BİR AN BİLE
-- kesinti/permission-denied penceresi oluşmaz — REVOKE ALL + yeniden GRANT
-- SELECT deseninin aksine. (MAINTAIN — PG17 VACUUM/ANALYZE — güvenlik açısından
-- nötr; bilinçli olarak dokunulmaz ve sürüm-taşınabilirliği korunur.)
-- Bu, tablo-seviyesi UPDATE grant'ını kaldırır → eski NO-OP kolon REVOKE'ları
-- (gold / moderation_status / suspended_until) ile aşağıdaki kolon GRANT'ları
-- artık GERÇEKTEN uygulanır (column-level ACL tablo-level tarafından gölgelenmez).
revoke insert, update, delete, truncate, references, trigger
  on public.profiles from anon, authenticated;

-- SELECT bilinçli olarak KORUNUR (GRANT ALL'dan gelen) — profiles dünya-okunur
-- (RLS "Profiles are viewable by everyone" USING(true)). anon + authenticated
-- okuyabilir; yazamaz. (Idempotency/açıklık için SELECT'i açıkça teyit ederiz.)
grant select on public.profiles to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) authenticated — YALNIZ kullanıcı-editable kolonlarda kolon-seviyesi yazma
-- ----------------------------------------------------------------------------
-- INSERT (ilk profil oluşturma — createProfile / setInitialUsername). Client
-- SADECE bu kolonları verir; gold/xp/level DEFAULT (0/0/1) alır, profile_code'u
-- trg_assign_profile_code atar. Böylece kullanıcı ilk kayıtta keyfi yüksek
-- ekonomi başlangıç değeri GÖNDEREMEZ (kolon INSERT yetkisi yok → permission denied).
grant insert (id, username, username_normalized, has_chosen_username, username_source)
  on public.profiles to authenticated;

-- UPDATE — client updateUsername / updateAvatar / setInitialUsername(update dalı)
-- tam olarak bu kolon kümesini yazar. RLS own-row (auth.uid()=id) satırı ayrıca
-- daraltır. Ekonomi/ilerleme/moderasyon/guard/sistem kolonları LİSTEDE YOK →
-- doğrudan REST UPDATE ile değiştirilemez.
grant update (username, avatar_id, username_normalized, has_chosen_username, username_source, updated_at)
  on public.profiles to authenticated;

-- anon: bilinçli olarak HİÇBİR INSERT/UPDATE/DELETE verilmez (yalnız yukarıdaki
-- SELECT). anon'un geçerli auth.uid()'si de olamaz.

-- ----------------------------------------------------------------------------
-- 3) NOTLAR — kilitlenen kolonların GERÇEK zorlaması
-- ----------------------------------------------------------------------------
comment on column public.profiles.gold is
  'SUNUCU-OTORİTER ekonomi. authenticated DOĞRUDAN yazamaz (kolon UPDATE yetkisi '
  'yok — 20260807120000). Yalnız SECURITY DEFINER RPC (award_gameplay_gold / '
  'spend_gameplay_gold / claim_daily_gold_bonus / _apply_gold_delta) veya '
  'postgres/service_role değiştirir.';
comment on column public.profiles.xp is
  'SUNUCU-OTORİTER ilerleme. authenticated DOĞRUDAN yazamaz (20260807120000). '
  'Yalnız award_xp_event / claim_* DEFINER RPC''leri veya postgres/service_role.';
comment on column public.profiles.level is
  'SUNUCU-OTORİTER ilerleme. authenticated DOĞRUDAN yazamaz (20260807120000).';
comment on column public.profiles.is_test_account is
  'SİSTEM bayrağı (leaderboard gizleme). authenticated DOĞRUDAN yazamaz (20260807120000).';

-- ----------------------------------------------------------------------------
-- 4) DOĞRULAMA (read-only — elle koşulur; migration akışını etkilemez)
-- ----------------------------------------------------------------------------
--   -- Tablo-seviyesi UPDATE artık YOK (kolon-grant'ları gölgeleyen taban gitti):
--   select has_table_privilege('authenticated','public.profiles','UPDATE');   -- f
--   select has_table_privilege('authenticated','public.profiles','INSERT');   -- f
--   select has_table_privilege('authenticated','public.profiles','DELETE');   -- f
--   select has_table_privilege('anon','public.profiles','UPDATE');            -- f
--   -- SUNUCU-OTORİTER kolonlar authenticated'a KAPALI:
--   select has_column_privilege('authenticated','public.profiles','gold','UPDATE');            -- f
--   select has_column_privilege('authenticated','public.profiles','xp','UPDATE');              -- f
--   select has_column_privilege('authenticated','public.profiles','level','UPDATE');           -- f
--   select has_column_privilege('authenticated','public.profiles','is_test_account','UPDATE'); -- f
--   select has_column_privilege('authenticated','public.profiles','moderation_status','UPDATE');-- f
--   select has_column_privilege('authenticated','public.profiles','profile_code','UPDATE');    -- f
--   -- KULLANICI-EDITABLE kolonlar AÇIK:
--   select has_column_privilege('authenticated','public.profiles','username','UPDATE');   -- t
--   select has_column_privilege('authenticated','public.profiles','avatar_id','UPDATE');  -- t
--   -- INSERT: gold KAPALI, username AÇIK:
--   select has_column_privilege('authenticated','public.profiles','gold','INSERT');       -- f
--   select has_column_privilege('authenticated','public.profiles','username','INSERT');   -- t
