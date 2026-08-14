-- ============================================================================
-- Bayrak Grup — HOST-SPOF KALDIRILDI + SIRA SUNUCUDA ÜRETİLİR
-- ============================================================================
-- KÖK NEDEN (bu migration'ın kapattığı)
-- ------------------------------------
-- Bayrak Grup'ta maçın İLERLEMESİ tamamen host'un tarayıcısına bağlıydı ve
-- ÜÇ ayrı ayakta SPOF üretiyordu:
--
--   (1) BAYRAK SIRASI HOST RAM'İNDEYDİ. `FlagGroupGame.buildHostSequence`
--       `buildProgressionQueue(pool, totalRounds)` ile sırayı host'un
--       belleğinde kuruyordu. Varsayılan rng `Math.random` olduğu için sıra
--       HİÇBİR YERDE persist DEĞİLDİ ve host kaybolunca DETERMİNİSTİK OLARAK
--       YENİDEN ÜRETİLEMİYORDU (kova-içi shuffle + ağırlıklı seçim, tohum yok).
--
--   (2) İLERLETME HOST-ONLY RPC'YDİ. `flag_group_advance_flag`
--       `flag_group_authorize_host` ile korunuyordu → odanın diğer 9 üyesinden
--       HİÇBİRİ turu ilerletemiyordu. Sunucu timeout'u DOĞRULUYORDU
--       (`now() < current_flag_at + 10 saniye` → `round_active`) ama
--       TETİKLEYİCİ yine yalnız host'tu; doğrulama SPOF'u kaldırmıyordu.
--
--   (3) NON-HOST GÜVENLİK AĞI YETERSİZDİ. İstemci non-host'a yalnız
--       `current_round >= total_rounds` VE tur PAS DEĞİLKEN `finalize_game`
--       çağırtıyordu. Sonuç: host tur 3/10'da arka plana düşerse maç TÜM
--       oyuncular için SONSUZA KADAR donuyordu; son turda pas olursa da
--       (`roundPassed → return`) donuyordu.
--
-- Donan aşamalar: sonraki bayrak, pas sonrası yeni bayrak, TIMEOUT, ve son tur
-- dışındaki her maç sonu. (Pas OYLAMASININ kendisi zaten sunucudaydı ve
-- sağlamdı — eşik `floor(active/2)+1` kilit altında hesaplanıyordu.)
--
-- ÇÖZÜM — Çark (20260814150000) modelinin birebir uyarlaması
-- ---------------------------------------------------------
--   1. `flag_group_flag_catalog` — kanonik havuz (bölge × country_code ×
--      fame_tier). İçerik `src/data/countries.ts`ten GERÇEK `getFlagPool()` /
--      `getFameTier()` çağrılarıyla üretildi (scripts/build-flag-group-catalog.ts)
--      → tier kuralları (ICONIC / mikro-devlet / difficulty) ve `counted`/`code`
--      filtreleri birebir korunur; SQL'e elle port EDİLMEDİ.
--   2. `flag_group_generate_sequence(region, span)` — `buildProgressionQueue`nun
--      SQL portu: tier kovaları + `progressionTierWeights` bantları + ağırlıklı
--      seçim + boş-kova "en yakın ortalama" yedeği. Rastgelelik SUNUCUDA.
--   3. Sıra `flag_group_room_sequences` PRIVATE tablosunda tutulur (anon/
--      authenticated'a grant YOK, RLS default-deny, realtime publication DIŞI)
--      → hiçbir istemci (host dâhil) GELECEK bayrakları okuyamaz. Bu, hız
--      oyununda önden-cevap avantajını yapısal olarak imkânsız kılar.
--   4. `flag_group_advance_if_due` — odanın HERHANGİ bir doğrulanmış üyesi
--      çağırabilir. Yetki genişlemesi DEĞİLDİR: sunucu deadline'ı KİLİTLİ oda
--      satırından kendi saatiyle okur, sıradaki bayrağı PRIVATE diziden seçer,
--      CAS (`p_expected_flag_seq`) + satır kilidi ile çift-ilerlemeyi imkânsız
--      kılar. Çağıranın yaptırabildiği tek geçiş, sunucunun o an ZATEN
--      yapacağı geçiştir.
--
-- ÜRÜN SEMANTİĞİ DEĞİŞMEDİ
-- ------------------------
--   • Havuz AYNI (`getFlagPool(bölge,'all')`), span AYNI (`total_rounds`),
--     bant ağırlıkları AYNI ([10,3,0,0]/[2,8,2,0]/[0,2,7,2]/[0,0,2,8]).
--   • Zamanlama AYNI: bayrak süresi 10 sn, cevap gösterimi 2000 ms. Sunucu
--     artık bu iki değeri KENDİ uygular (istemci timer'ı yalnız UI).
--   • PAS turu TÜKETMEZ (round sabit, flag_seq++), pas eşiği floor(N/2)+1,
--     skor = gerçek claim sayısı, kazanan sıralaması, tur sayısı, UI: HEPSİ AYNI.
--   • Misafir (anon) oynayabildiği için yeni RPC anon+authenticated'a AÇIK;
--     körlemesine revoke YAPILMADI.
--
-- GERİYE UYUMLULUK — ESKİ İSTEMCİ BOZULMAZ (release blocker)
-- ----------------------------------------------------------
-- Bu migration, App Store'daki GÜNCELLENMEMİŞ istemciden GÜNLER/HAFTALAR önce
-- canlıya çıkabilir. Bu yüzden HİÇBİR RPC drop/revoke EDİLMEZ:
--   • `flag_group_advance_flag` → geriye uyumluluk SHIM'i (bkz. 11). İmza,
--     dönüş tipi, host-only yetkisi ve `round_active` reddi AYNEN korunur;
--     yalnız `p_next_flag` artık OKUNMAZ.
--   • `flag_group_start_game`   → imza korunur, `p_first_flag` OKUNMAZ (bkz. 8).
--   • `flag_group_finalize_game`→ imza/dönüş korunur, erken çağrı artık NO-OP
--     (raise DEĞİL) → eski istemcinin güvenlik ağı sessizce etkisiz kalır (bkz. 12).
-- Eski istemci (host) ile yeni istemci (watchdog) AYNI odada, AYNI state
-- machine üzerinde (`flag_group_advance_core`) güvenle çalışır; CAS + satır
-- kilidi eşzamanlılıkta TEK geçiş garanti eder.
--
-- KAPATILAN İKİ GÜVENLİK AÇIĞI
-- ----------------------------
--   1. BAYRAK ENJEKSİYONU: `advance_flag` istemciden `p_next_flag` alıyordu →
--      host maçın her turunda hangi bayrağın geleceğini SEÇEBİLİYORDU (kolay
--      bayrakları öne alma). Biçim guard'ı (^[a-z]{2}$) bunu ENGELLEMİYORDU.
--      Artık parametre kabul edilir ama OKUNMAZ; hedefi sunucu PRIVATE
--      dizisinden seçer → eski istemci bile canonical state'i manipüle EDEMEZ.
--   2. ERKEN BİTİRME (GRIEFING): `finalize_game` HİÇBİR deadline kontrolü
--      YAPMIYORDU → odanın herhangi bir üyesi tur 2/20'de maçı kapatabiliyordu.
--      Artık yalnız "ilerletme zaten finalize edecek olsaydı" bitirir (bkz. 12).
--
-- DOKUNULMAYAN
-- ------------
--   flag_group_submit_claim, flag_group_toggle_pass_vote (pas eşiği zaten
--   sunucuda ve sağlamdı), return_to_lobby, kick, leave_room,
--   join/create/update_settings, heartbeat, send_message ve DİĞER TÜM MODLAR
--   (wheel_*, duel_*, flag_duel_*, conquest_*, kornokta_*).
--
-- IDEMPOTENT: create table if not exists / on conflict do update /
--             create or replace function → tekrar koşulabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Kanonik bayrak kataloğu — PRIVATE
-- ----------------------------------------------------------------------------
-- Satırlar scripts/build-flag-group-catalog.ts tarafından ÜRETİLDİ. Elle
-- düzenleme; countries.ts değişirse script yeniden koşulur (drift testi
-- check-flag-group-advance-if-due.ts'te kilitli).
--
-- NOT: Çark kataloğundan FARKLI — Bayrak havuzu `isWheelEligible` ile
-- filtrelenmez (mikro-devletler Bayrak'ta VARDIR, tier 4'e düşerler) ve
-- MULTI_CONTINENT uygulanmaz (`getFlagPool` düz `c.continent` eşleşmesi yapar).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.flag_group_flag_catalog (
  region       text not null,
  country_code text not null,
  fame_tier    int  not null check (fame_tier between 1 and 4),
  primary key (region, country_code)
);

alter table public.flag_group_flag_catalog enable row level security;
-- Policy YOK → RLS default-deny. SECURITY DEFINER fonksiyonları (owner) bypass
-- eder. Grant de yok → çifte kilit.
revoke all on table public.flag_group_flag_catalog from anon, authenticated, public;

insert into public.flag_group_flag_catalog (region, country_code, fame_tier) values
  ('world', 'al', 2),
  ('world', 'ad', 4),
  ('world', 'at', 2),
  ('world', 'by', 2),
  ('world', 'be', 2),
  ('world', 'ba', 2),
  ('world', 'bg', 2),
  ('world', 'hr', 2),
  ('world', 'cy', 2),
  ('world', 'cz', 2),
  ('world', 'dk', 2),
  ('world', 'ee', 3),
  ('world', 'fi', 2),
  ('world', 'fr', 1),
  ('world', 'de', 1),
  ('world', 'gr', 1),
  ('world', 'hu', 2),
  ('world', 'is', 2),
  ('world', 'ie', 2),
  ('world', 'it', 1),
  ('world', 'lv', 2),
  ('world', 'li', 4),
  ('world', 'lt', 2),
  ('world', 'lu', 2),
  ('world', 'mt', 4),
  ('world', 'md', 3),
  ('world', 'mc', 4),
  ('world', 'me', 3),
  ('world', 'nl', 1),
  ('world', 'mk', 2),
  ('world', 'no', 2),
  ('world', 'pl', 2),
  ('world', 'pt', 1),
  ('world', 'ro', 2),
  ('world', 'ru', 1),
  ('world', 'sm', 4),
  ('world', 'rs', 2),
  ('world', 'sk', 2),
  ('world', 'si', 2),
  ('world', 'es', 1),
  ('world', 'se', 2),
  ('world', 'ch', 2),
  ('world', 'ua', 1),
  ('world', 'gb', 1),
  ('world', 'va', 4),
  ('world', 'xk', 4),
  ('world', 'af', 2),
  ('world', 'am', 2),
  ('world', 'az', 1),
  ('world', 'bh', 4),
  ('world', 'bd', 2),
  ('world', 'bt', 4),
  ('world', 'bn', 4),
  ('world', 'kh', 3),
  ('world', 'cn', 1),
  ('world', 'ge', 3),
  ('world', 'in', 1),
  ('world', 'id', 2),
  ('world', 'ir', 1),
  ('world', 'iq', 1),
  ('world', 'il', 2),
  ('world', 'jp', 1),
  ('world', 'jo', 3),
  ('world', 'kz', 2),
  ('world', 'kw', 2),
  ('world', 'kg', 3),
  ('world', 'la', 3),
  ('world', 'lb', 2),
  ('world', 'my', 2),
  ('world', 'mv', 4),
  ('world', 'mn', 2),
  ('world', 'mm', 2),
  ('world', 'np', 2),
  ('world', 'kp', 2),
  ('world', 'om', 3),
  ('world', 'pk', 2),
  ('world', 'ps', 3),
  ('world', 'ph', 2),
  ('world', 'qa', 3),
  ('world', 'sa', 1),
  ('world', 'sg', 4),
  ('world', 'kr', 1),
  ('world', 'lk', 2),
  ('world', 'sy', 2),
  ('world', 'tj', 3),
  ('world', 'th', 2),
  ('world', 'tl', 4),
  ('world', 'tr', 1),
  ('world', 'tm', 3),
  ('world', 'ae', 2),
  ('world', 'uz', 3),
  ('world', 'vn', 2),
  ('world', 'ye', 2),
  ('world', 'dz', 2),
  ('world', 'ao', 2),
  ('world', 'bj', 4),
  ('world', 'bw', 3),
  ('world', 'bf', 4),
  ('world', 'bi', 4),
  ('world', 'cv', 4),
  ('world', 'cm', 2),
  ('world', 'cf', 3),
  ('world', 'td', 2),
  ('world', 'km', 4),
  ('world', 'cg', 3),
  ('world', 'cd', 2),
  ('world', 'ci', 2),
  ('world', 'dj', 4),
  ('world', 'eg', 1),
  ('world', 'gq', 4),
  ('world', 'er', 4),
  ('world', 'et', 2),
  ('world', 'ga', 4),
  ('world', 'gm', 4),
  ('world', 'gh', 2),
  ('world', 'gn', 4),
  ('world', 'gw', 4),
  ('world', 'ke', 2),
  ('world', 'ls', 4),
  ('world', 'lr', 4),
  ('world', 'ly', 2),
  ('world', 'mg', 2),
  ('world', 'mw', 3),
  ('world', 'ml', 2),
  ('world', 'mr', 4),
  ('world', 'mu', 4),
  ('world', 'ma', 2),
  ('world', 'mz', 2),
  ('world', 'na', 2),
  ('world', 'ne', 4),
  ('world', 'ng', 2),
  ('world', 'rw', 2),
  ('world', 'st', 4),
  ('world', 'sn', 2),
  ('world', 'sc', 4),
  ('world', 'sl', 4),
  ('world', 'so', 2),
  ('world', 'za', 2),
  ('world', 'ss', 2),
  ('world', 'sd', 2),
  ('world', 'sz', 4),
  ('world', 'tz', 2),
  ('world', 'tg', 4),
  ('world', 'tn', 2),
  ('world', 'ug', 2),
  ('world', 'zm', 2),
  ('world', 'zw', 2),
  ('world', 'ag', 4),
  ('world', 'bs', 3),
  ('world', 'bb', 4),
  ('world', 'bz', 4),
  ('world', 'ca', 1),
  ('world', 'cr', 3),
  ('world', 'cu', 2),
  ('world', 'dm', 4),
  ('world', 'do', 2),
  ('world', 'sv', 3),
  ('world', 'gd', 4),
  ('world', 'gt', 2),
  ('world', 'ht', 2),
  ('world', 'hn', 2),
  ('world', 'jm', 3),
  ('world', 'mx', 1),
  ('world', 'ni', 3),
  ('world', 'pa', 2),
  ('world', 'kn', 4),
  ('world', 'lc', 4),
  ('world', 'vc', 4),
  ('world', 'tt', 3),
  ('world', 'us', 1),
  ('world', 'ar', 1),
  ('world', 'bo', 3),
  ('world', 'br', 1),
  ('world', 'cl', 2),
  ('world', 'co', 2),
  ('world', 'ec', 2),
  ('world', 'gy', 4),
  ('world', 'py', 4),
  ('world', 'pe', 2),
  ('world', 'sr', 4),
  ('world', 'uy', 4),
  ('world', 've', 2),
  ('world', 'au', 1),
  ('world', 'fj', 4),
  ('world', 'ki', 4),
  ('world', 'mh', 4),
  ('world', 'fm', 4),
  ('world', 'nr', 4),
  ('world', 'nz', 2),
  ('world', 'pw', 4),
  ('world', 'pg', 3),
  ('world', 'ws', 4),
  ('world', 'sb', 4),
  ('world', 'to', 4),
  ('world', 'tv', 4),
  ('world', 'vu', 4),
  ('europe', 'al', 2),
  ('europe', 'ad', 4),
  ('europe', 'at', 2),
  ('europe', 'by', 2),
  ('europe', 'be', 2),
  ('europe', 'ba', 2),
  ('europe', 'bg', 2),
  ('europe', 'hr', 2),
  ('europe', 'cy', 2),
  ('europe', 'cz', 2),
  ('europe', 'dk', 2),
  ('europe', 'ee', 3),
  ('europe', 'fi', 2),
  ('europe', 'fr', 1),
  ('europe', 'de', 1),
  ('europe', 'gr', 1),
  ('europe', 'hu', 2),
  ('europe', 'is', 2),
  ('europe', 'ie', 2),
  ('europe', 'it', 1),
  ('europe', 'lv', 2),
  ('europe', 'li', 4),
  ('europe', 'lt', 2),
  ('europe', 'lu', 2),
  ('europe', 'mt', 4),
  ('europe', 'md', 3),
  ('europe', 'mc', 4),
  ('europe', 'me', 3),
  ('europe', 'nl', 1),
  ('europe', 'mk', 2),
  ('europe', 'no', 2),
  ('europe', 'pl', 2),
  ('europe', 'pt', 1),
  ('europe', 'ro', 2),
  ('europe', 'ru', 1),
  ('europe', 'sm', 4),
  ('europe', 'rs', 2),
  ('europe', 'sk', 2),
  ('europe', 'si', 2),
  ('europe', 'es', 1),
  ('europe', 'se', 2),
  ('europe', 'ch', 2),
  ('europe', 'ua', 1),
  ('europe', 'gb', 1),
  ('europe', 'va', 4),
  ('europe', 'xk', 4),
  ('asia', 'af', 2),
  ('asia', 'am', 2),
  ('asia', 'az', 1),
  ('asia', 'bh', 4),
  ('asia', 'bd', 2),
  ('asia', 'bt', 4),
  ('asia', 'bn', 4),
  ('asia', 'kh', 3),
  ('asia', 'cn', 1),
  ('asia', 'ge', 3),
  ('asia', 'in', 1),
  ('asia', 'id', 2),
  ('asia', 'ir', 1),
  ('asia', 'iq', 1),
  ('asia', 'il', 2),
  ('asia', 'jp', 1),
  ('asia', 'jo', 3),
  ('asia', 'kz', 2),
  ('asia', 'kw', 2),
  ('asia', 'kg', 3),
  ('asia', 'la', 3),
  ('asia', 'lb', 2),
  ('asia', 'my', 2),
  ('asia', 'mv', 4),
  ('asia', 'mn', 2),
  ('asia', 'mm', 2),
  ('asia', 'np', 2),
  ('asia', 'kp', 2),
  ('asia', 'om', 3),
  ('asia', 'pk', 2),
  ('asia', 'ps', 3),
  ('asia', 'ph', 2),
  ('asia', 'qa', 3),
  ('asia', 'sa', 1),
  ('asia', 'sg', 4),
  ('asia', 'kr', 1),
  ('asia', 'lk', 2),
  ('asia', 'sy', 2),
  ('asia', 'tj', 3),
  ('asia', 'th', 2),
  ('asia', 'tl', 4),
  ('asia', 'tr', 1),
  ('asia', 'tm', 3),
  ('asia', 'ae', 2),
  ('asia', 'uz', 3),
  ('asia', 'vn', 2),
  ('asia', 'ye', 2),
  ('africa', 'dz', 2),
  ('africa', 'ao', 2),
  ('africa', 'bj', 4),
  ('africa', 'bw', 3),
  ('africa', 'bf', 4),
  ('africa', 'bi', 4),
  ('africa', 'cv', 4),
  ('africa', 'cm', 2),
  ('africa', 'cf', 3),
  ('africa', 'td', 2),
  ('africa', 'km', 4),
  ('africa', 'cg', 3),
  ('africa', 'cd', 2),
  ('africa', 'ci', 2),
  ('africa', 'dj', 4),
  ('africa', 'eg', 1),
  ('africa', 'gq', 4),
  ('africa', 'er', 4),
  ('africa', 'et', 2),
  ('africa', 'ga', 4),
  ('africa', 'gm', 4),
  ('africa', 'gh', 2),
  ('africa', 'gn', 4),
  ('africa', 'gw', 4),
  ('africa', 'ke', 2),
  ('africa', 'ls', 4),
  ('africa', 'lr', 4),
  ('africa', 'ly', 2),
  ('africa', 'mg', 2),
  ('africa', 'mw', 3),
  ('africa', 'ml', 2),
  ('africa', 'mr', 4),
  ('africa', 'mu', 4),
  ('africa', 'ma', 2),
  ('africa', 'mz', 2),
  ('africa', 'na', 2),
  ('africa', 'ne', 4),
  ('africa', 'ng', 2),
  ('africa', 'rw', 2),
  ('africa', 'st', 4),
  ('africa', 'sn', 2),
  ('africa', 'sc', 4),
  ('africa', 'sl', 4),
  ('africa', 'so', 2),
  ('africa', 'za', 2),
  ('africa', 'ss', 2),
  ('africa', 'sd', 2),
  ('africa', 'sz', 4),
  ('africa', 'tz', 2),
  ('africa', 'tg', 4),
  ('africa', 'tn', 2),
  ('africa', 'ug', 2),
  ('africa', 'zm', 2),
  ('africa', 'zw', 2),
  ('north_america', 'ag', 4),
  ('north_america', 'bs', 3),
  ('north_america', 'bb', 4),
  ('north_america', 'bz', 4),
  ('north_america', 'ca', 1),
  ('north_america', 'cr', 3),
  ('north_america', 'cu', 2),
  ('north_america', 'dm', 4),
  ('north_america', 'do', 2),
  ('north_america', 'sv', 3),
  ('north_america', 'gd', 4),
  ('north_america', 'gt', 2),
  ('north_america', 'ht', 2),
  ('north_america', 'hn', 2),
  ('north_america', 'jm', 3),
  ('north_america', 'mx', 1),
  ('north_america', 'ni', 3),
  ('north_america', 'pa', 2),
  ('north_america', 'kn', 4),
  ('north_america', 'lc', 4),
  ('north_america', 'vc', 4),
  ('north_america', 'tt', 3),
  ('north_america', 'us', 1),
  ('south_america', 'ar', 1),
  ('south_america', 'bo', 3),
  ('south_america', 'br', 1),
  ('south_america', 'cl', 2),
  ('south_america', 'co', 2),
  ('south_america', 'ec', 2),
  ('south_america', 'gy', 4),
  ('south_america', 'py', 4),
  ('south_america', 'pe', 2),
  ('south_america', 'sr', 4),
  ('south_america', 'uy', 4),
  ('south_america', 've', 2),
  ('oceania', 'au', 1),
  ('oceania', 'fj', 4),
  ('oceania', 'ki', 4),
  ('oceania', 'mh', 4),
  ('oceania', 'fm', 4),
  ('oceania', 'nr', 4),
  ('oceania', 'nz', 2),
  ('oceania', 'pw', 4),
  ('oceania', 'pg', 3),
  ('oceania', 'ws', 4),
  ('oceania', 'sb', 4),
  ('oceania', 'to', 4),
  ('oceania', 'tv', 4),
  ('oceania', 'vu', 4)
on conflict (region, country_code) do update set fame_tier = excluded.fame_tier;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Sıra deposu — PRIVATE (istemci OKUYAMAZ)
-- ----------------------------------------------------------------------------
-- Oda satırında DEĞİL ayrı tabloda: flag_group_rooms anon SELECT'e açık ve
-- realtime `replica identity full` ile TAM satır yayınlıyor. Sıra orada dursa
-- her oyuncu maçın gelecek bayraklarını okuyabilirdi → hız oyununda cevabı
-- önceden yazma avantajı.
--
--   game_seq : sıranın ait olduğu oyun oturumu. start_game game_seq'i artırır →
--              satır YENİ diziyle tazelenir (aynı odada peş peşe maçlar ayrışır).
--   flags    : oyunun tam bayrak sırası (progression eğrisi).
--   used     : GÖSTERİLMİŞ bayraklar. İstemcideki `usedFlagsRef`in sunucu
--              karşılığı — TIMEOUT ile geçilen bayrak da buraya girer (claims'te
--              satırı YOKTUR, yalnız claim'lerden türetilse tekrar gösterilirdi).
-- FK cascade: oda silinince sıra da gider.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.flag_group_room_sequences (
  room_id    uuid   primary key
                    references public.flag_group_rooms(id) on delete cascade,
  game_seq   int    not null,
  flags      text[] not null,
  used       text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.flag_group_room_sequences enable row level security;
revoke all on table public.flag_group_room_sequences from anon, authenticated, public;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Zaman sabitleri — TEK KAYNAK
-- ----------------------------------------------------------------------------
-- İstemcideki FLAG_TIMEOUT_SEC (10) / REVEAL_DELAY_MS (2000) ile BİREBİR.
-- İstemci değerleri artık YALNIZ (a) UI geri sayımı ve (b) watchdog'un "ne
-- zaman sormaya değer" tahmini içindir; otoriter karar buradadır.
-- Drift'i scripts/check-flag-group-advance-if-due.ts iki tarafı okuyup kilitler.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_flag_timeout_seconds()
returns int language sql immutable as $$ select 10 $$;

create or replace function public.flag_group_reveal_delay_ms()
returns int language sql immutable as $$ select 2000 $$;

revoke all on function public.flag_group_flag_timeout_seconds() from public, anon, authenticated;
revoke all on function public.flag_group_reveal_delay_ms()      from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) progressionTierWeights portu
-- ----------------------------------------------------------------------------
-- countries.ts `progressionTierWeights` ile BİREBİR aynı bantlar ve ağırlıklar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_progression_tier_weights(p numeric)
returns int[]
language sql
immutable
as $$
  select case
    when least(greatest(coalesce(p, 0), 0), 1) < 0.40 then array[10, 3, 0, 0]
    when least(greatest(coalesce(p, 0), 0), 1) < 0.70 then array[2,  8, 2, 0]
    when least(greatest(coalesce(p, 0), 0), 1) < 0.90 then array[0,  2, 7, 2]
    else                                                   array[0,  0, 2, 8]
  end;
$$;

revoke all on function public.flag_group_progression_tier_weights(numeric) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) buildProgressionQueue portu
-- ----------------------------------------------------------------------------
-- countries.ts `buildProgressionQueue` + `chooseTier` + `bucketByTier`.
-- Rastgelelik SUNUCUDA (`random()`), istemci etkileyemez.
-- Bilinmeyen bölge → 'world' havuzuna düşer (dizi ASLA boş dönmez).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_generate_sequence(p_region text, p_span int)
returns text[]
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_region  text := p_region;
  v_out     text[] := '{}';
  v_total   int;
  v_span    int := greatest(coalesce(p_span, 10), 1);
  i         int;
  k         int;
  p         numeric;
  w         int[];
  avail     int[];
  sum_w     int;
  r         numeric;
  t         int;
  mean_t    numeric;
  tot_w     int;
  best      int;
  best_dist numeric;
  b1 text[]; b2 text[]; b3 text[]; b4 text[];
begin
  if v_region is null
     or not exists (select 1 from public.flag_group_flag_catalog where region = v_region) then
    v_region := 'world';
  end if;

  -- bucketByTier: tier başına kova + kova İÇİNDE rastgele sıra
  select coalesce(array_agg(country_code order by random()), '{}'::text[]) into b1
    from public.flag_group_flag_catalog where region = v_region and fame_tier = 1;
  select coalesce(array_agg(country_code order by random()), '{}'::text[]) into b2
    from public.flag_group_flag_catalog where region = v_region and fame_tier = 2;
  select coalesce(array_agg(country_code order by random()), '{}'::text[]) into b3
    from public.flag_group_flag_catalog where region = v_region and fame_tier = 3;
  select coalesce(array_agg(country_code order by random()), '{}'::text[]) into b4
    from public.flag_group_flag_catalog where region = v_region and fame_tier = 4;

  v_total := coalesce(array_length(b1,1),0) + coalesce(array_length(b2,1),0)
           + coalesce(array_length(b3,1),0) + coalesce(array_length(b4,1),0);
  if v_total = 0 then
    return '{}'::text[];
  end if;

  for i in 0..(v_total - 1) loop
    p := least(i::numeric / greatest(v_span - 1, 1)::numeric, 1);
    w := public.flag_group_progression_tier_weights(p);

    avail := array[
      case when coalesce(array_length(b1,1),0) > 0 then w[1] else 0 end,
      case when coalesce(array_length(b2,1),0) > 0 then w[2] else 0 end,
      case when coalesce(array_length(b3,1),0) > 0 then w[3] else 0 end,
      case when coalesce(array_length(b4,1),0) > 0 then w[4] else 0 end
    ];
    sum_w := avail[1] + avail[2] + avail[3] + avail[4];
    t := -1;

    if sum_w > 0 then
      r := random() * sum_w;
      for k in 1..4 loop
        r := r - avail[k];
        if r < 0 then t := k; exit; end if;
      end loop;
      if t < 0 then                                   -- kayan nokta yedeği
        for k in reverse 4..1 loop
          if avail[k] > 0 then t := k; exit; end if;
        end loop;
      end if;
    else
      -- chooseTier yedeği: ağırlıklı ortalama tier'a EN YAKIN dolu kova
      tot_w := w[1] + w[2] + w[3] + w[4];
      if tot_w > 0 then
        mean_t := (w[1]*0 + w[2]*1 + w[3]*2 + w[4]*3)::numeric / tot_w;
      else
        mean_t := 0;
      end if;
      best := -1; best_dist := null;
      for k in 1..4 loop
        if (k = 1 and coalesce(array_length(b1,1),0) > 0)
        or (k = 2 and coalesce(array_length(b2,1),0) > 0)
        or (k = 3 and coalesce(array_length(b3,1),0) > 0)
        or (k = 4 and coalesce(array_length(b4,1),0) > 0) then
          if best_dist is null or abs((k-1) - mean_t) < best_dist then
            best_dist := abs((k-1) - mean_t);
            best := k;
          end if;
        end if;
      end loop;
      t := best;
    end if;

    exit when t < 0;

    -- seçilen kovadan pop
    if t = 1 then v_out := array_append(v_out, b1[1]); b1 := b1[2:];
    elsif t = 2 then v_out := array_append(v_out, b2[1]); b2 := b2[2:];
    elsif t = 3 then v_out := array_append(v_out, b3[1]); b3 := b3[2:];
    else             v_out := array_append(v_out, b4[1]); b4 := b4[2:];
    end if;
  end loop;

  return v_out;
end;
$$;

revoke all on function public.flag_group_generate_sequence(text, int) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) Tembel + atomik sıra kurulumu
-- ----------------------------------------------------------------------------
-- ÇAĞIRAN ODA SATIRINI `FOR UPDATE` İLE KİLİTLEMİŞ OLMALIDIR (start_game /
-- advance_if_due / advance_flag hepsi kilitler) → aynı odada iki üretim yarışı
-- imkânsız. `on conflict do update … where game_seq <> excluded.game_seq`
-- ikinci bir savunma katmanıdır.
--
-- GEÇİŞ (bu migration'dan ÖNCE başlamış maçlar): sıra satırı yoksa `used`,
-- mevcut claim'lerden (gerçek claim → country_code, pas sentinel → `pass:` sonrası)
-- + o an gösterilen bayraktan tohumlanır → devam eden maçta ZATEN görülmüş
-- bayraklar tekrar gösterilmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_ensure_sequence(p_room_id uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_room  public.flag_group_rooms;
  v_seq   text[];
  v_gs    int;
  v_used  text[];
begin
  select * into v_room from public.flag_group_rooms where id = p_room_id;
  if v_room.id is null then
    return null;
  end if;

  select flags, game_seq into v_seq, v_gs
    from public.flag_group_room_sequences where room_id = p_room_id;
  if v_seq is not null and v_gs = v_room.game_seq then
    return v_seq;
  end if;

  v_seq := public.flag_group_generate_sequence(v_room.region, v_room.total_rounds);
  if coalesce(array_length(v_seq, 1), 0) = 0 then
    return null;
  end if;

  -- Devam eden maç için gösterilmiş bayrakları tohumla (yalnız satır YOKKEN
  -- anlamlı; taze start_game'de claim de olmaz, current_flag zaten diziden gelir).
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_used
    from (
      select case when c.country_code like 'pass:%'
                  then substring(c.country_code from 6)
                  else c.country_code end as x
        from public.flag_group_claims c
       where c.room_id  = p_room_id
         and c.game_seq = v_room.game_seq
         and (c.country_code not like '%:%' or c.country_code like 'pass:%')
    ) s
   where x is not null and x <> '';

  insert into public.flag_group_room_sequences (room_id, game_seq, flags, used)
  values (p_room_id, v_room.game_seq, v_seq, v_used)
  on conflict (room_id) do update
    set game_seq   = excluded.game_seq,
        flags      = excluded.flags,
        used       = excluded.used,
        created_at = now()
  where public.flag_group_room_sequences.game_seq <> excluded.game_seq;

  select flags into v_seq
    from public.flag_group_room_sequences where room_id = p_room_id;
  return v_seq;
end;
$$;

revoke all on function public.flag_group_ensure_sequence(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) next_flag — PRIVATE diziden ilk KULLANILMAMIŞ bayrak
-- ----------------------------------------------------------------------------
-- İstemcideki `pickNextFlagCode(flagSeqCodesRef, usedFlagsRef)` ile aynı kural:
-- sıra korunur, gösterilmiş bayrak ASLA tekrar gelmez. `current_flag` de
-- dışlanır (henüz `used`'a girmemiş olan o an gösterilen bayrak).
-- Dizi tükendiyse null → çağıran finalize eder (havuzu total_rounds'tan küçük
-- bölgeler — örn. Güney Amerika 12 bayrak — için MEŞRU son).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_next_flag(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select f.code
    from public.flag_group_rooms r
    join public.flag_group_room_sequences q on q.room_id = r.id
    cross join lateral unnest(q.flags) with ordinality as f(code, ord)
   where r.id = p_room_id
     and f.code is not null
     and f.code <> ''
     and not (f.code = any (coalesce(q.used, '{}'::text[])))
     and f.code is distinct from r.current_flag
   order by f.ord
   limit 1;
$$;

revoke all on function public.flag_group_next_flag(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) flag_group_start_game — İLK BAYRAK ARTIK SUNUCUDAN
-- ----------------------------------------------------------------------------
-- 20260731120000 sürümüyle AYNI kapılar (host yetkisi, waiting, >=2 oyuncu,
-- players_not_ready, claim temizliği, game_seq++/flag_seq=1). TEK fark:
-- `current_flag` artık SUNUCUNUN ürettiği dizinin BAŞINDAN gelir.
--
-- `p_first_flag` İMZADA KALIR ama ARTIK KULLANILMAZ (inert). Neden imza
-- korunuyor: dağıtım anında sayfayı yenilememiş ESKİ istemci hâlâ 4 argümanla
-- çağırıyor; imza düşerse lobide "oyunu başlat" kırılırdı. Değer okunmadığı
-- için istemci ilk bayrağı SEÇEMEZ — enjeksiyon yüzeyi kapalı.
-- (Eski `first_flag_required` guard'ı bilerek KALDIRILDI: yeni istemci null yollar.)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_flag     text
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room       public.flag_group_rooms;
  v_count      int;
  v_not_ready  int;
  v_seq        text[];
  v_first      text;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.flag_group_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  select count(*) into v_not_ready
    from public.flag_group_players
   where room_id = p_room_id and status <> 'waiting';
  if v_not_ready > 0 then
    raise exception 'players_not_ready' using errcode = 'P0001';
  end if;

  -- Yeni oyun oturumunun sırasını ÜRET ve PRIVATE tabloya yaz. game_seq henüz
  -- artmadığı için satırı doğrudan (hedef game_seq ile) yazıyoruz; oda satırı
  -- FOR UPDATE ile kilitli olduğundan yarış yok.
  v_seq := public.flag_group_generate_sequence(v_room.region, v_room.total_rounds);
  if coalesce(array_length(v_seq, 1), 0) = 0 then
    raise exception 'flag_pool_empty' using errcode = 'P0001';
  end if;
  v_first := v_seq[1];

  insert into public.flag_group_room_sequences (room_id, game_seq, flags, used)
  values (p_room_id, v_room.game_seq + 1, v_seq, '{}'::text[])
  on conflict (room_id) do update
    set game_seq   = excluded.game_seq,
        flags      = excluded.flags,
        used       = excluded.used,
        created_at = now();

  delete from public.flag_group_claims where room_id = p_room_id;

  update public.flag_group_players
     set status = 'playing', last_seen_at = now()
   where room_id = p_room_id;

  update public.flag_group_rooms
     set status          = 'playing',
         started_at      = now(),
         finished_at     = null,
         current_round   = 1,
         current_flag    = v_first,
         current_flag_at = now(),
         game_seq        = game_seq + 1,
         flag_seq        = 1,
         updated_at      = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_group_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) flag_group_advance_core — TEK OTOMAT (iki giriş kapısı da buraya iner)
-- ----------------------------------------------------------------------------
-- PRIVATE (anon/authenticated'a grant YOK). Yetki KONTROLÜ YAPMAZ — çağıran
-- wrapper zaten yapmıştır. Odayı KENDİ kilitler (aynı işlemde tekrar kilit
-- almak no-op'tur; wrapper'lar kilidi burada alır).
--
-- İKİ ÇAĞIRAN, TEK STATE MACHINE:
--   • flag_group_advance_if_due  (YENİ istemci, her üye)   → p_legacy = false
--   • flag_group_advance_flag    (ESKİ istemci, host-only) → p_legacy = true
-- Böylece karışık sürüm (old host + new üye) AYNI otomatı sürer; CAS + satır
-- kilidi tek geçişi garanti eder.
--
-- p_legacy'nin TEK farkı GEÇİŞ ANI KAPISIDIR — ürün kararları (pas/claim/
-- timeout, finalize, used, sıra) İKİ YOLDA DA AYNIDIR:
--
--   p_legacy = false (yeni istemci, watchdog yokluyor):
--     çözüm VAR → claim.created_at + reveal(2000 ms)
--     çözüm YOK → current_flag_at + timeout(10 sn) + reveal(2000 ms)
--     Vakti gelmediyse → NO-OP (return). Watchdog 500 ms'de bir sorduğu için
--     RAISE etmek anlamsız hata gürültüsü üretirdi.
--
--   p_legacy = true (ESKİ istemci — 20260731120000 SÖZLEŞMESİ BİREBİR KORUNUR):
--     çözüm VAR → HEMEN ilerlet (eski sunucuda da reveal kapısı YOKTU; 2000 ms'i
--                 eski istemci KENDİ timer'ıyla beklerdi)
--     çözüm YOK → now() < current_flag_at + 10 sn ise `round_active` RAISE
--                 (eski sunucunun ta kendisi)
--     NEDEN AYNEN KORUNUYOR: eski istemcinin hata yolu
--     `advanceHandledRef.current = ""` yapıp DÖNER — otomatik yeniden deneme
--     DÖNGÜSÜ YOKTUR (yeniden render gerekir). Yani legacy yola YENİ bir hata
--     modu (örn. 12 sn'lik daha geç kapı) eklemek, eski istemcide turu KALICI
--     olarak asabilirdi. Eski istemci zaten +12 sn'de çağırdığı için 10 sn'lik
--     kapı her zaman AÇIKTIR.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_advance_core(
  p_room_id           uuid,
  p_expected_flag_seq int,
  p_legacy            boolean
) returns public.flag_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.flag_group_rooms;
  v_now        timestamptz := now();
  v_res        text;
  v_res_at     timestamptz;
  v_passed     boolean;
  v_due_at     timestamptz;
  v_next       text;
  v_next_round int;
  v_seq        text[];
begin
  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Oyunda değil → idempotent no-op (başka üye finalize etmiş olabilir).
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- CAS: bu bayrak zaten ilerletildiyse HİÇBİR mutation yapılmadan no-op.
  if p_expected_flag_seq is distinct from v_room.flag_seq then
    return v_room;
  end if;

  -- Sıra tembel + atomik kurulur (kilit bizde).
  v_seq := public.flag_group_ensure_sequence(p_room_id);

  select country_code, created_at into v_res, v_res_at
    from public.flag_group_claims
   where room_id  = p_room_id
     and game_seq = v_room.game_seq
     and flag_seq = v_room.flag_seq
   limit 1;

  v_passed := (v_res is not null and v_res like 'pass:%');

  -- ── GEÇİŞ ANI KAPISI (SUNUCU saati; istemci saati karara GİRMEZ) ──
  if p_legacy then
    -- ESKİ SÖZLEŞME: yalnız "çözüm yok + süre dolmadı" reddedilir (raise).
    if v_res is null then
      if v_room.current_flag_at is null
         or v_now < v_room.current_flag_at
                    + make_interval(secs => public.flag_group_flag_timeout_seconds())
      then
        raise exception 'round_active' using errcode = 'P0001';
      end if;
    end if;
  else
    if v_res is not null then
      v_due_at := v_res_at
                  + make_interval(secs => public.flag_group_reveal_delay_ms() / 1000.0);
    else
      if v_room.current_flag_at is null then
        return v_room;                    -- tur başlangıcı bilinmiyor → dokunma
      end if;
      v_due_at := v_room.current_flag_at
                  + make_interval(secs => public.flag_group_flag_timeout_seconds())
                  + make_interval(secs => public.flag_group_reveal_delay_ms() / 1000.0);
    end if;
    if v_now < v_due_at then
      return v_room;                      -- ERKEN → mutation YOK
    end if;
  end if;

  -- ── Sıradaki bayrak: HER İKİ YOLDA DA sunucunun PRIVATE dizisinden ──
  v_next := public.flag_group_next_flag(p_room_id);

  if v_passed then
    -- PAS: tur numarası DEĞİŞMEZ, yeni bayrak aynı tur altında.
    if v_next is null then
      update public.flag_group_rooms
         set status = 'finished', finished_at = v_now, updated_at = v_now
       where id = p_room_id and status = 'playing'
       returning * into v_room;
      if v_room.id is null then
        select * into v_room from public.flag_group_rooms where id = p_room_id;
      end if;
      update public.flag_group_players
         set status = 'finished', last_seen_at = v_now
       where room_id = p_room_id;
      return v_room;
    end if;

    update public.flag_group_room_sequences
       set used = array_append(coalesce(used, '{}'::text[]), v_room.current_flag)
     where room_id = p_room_id
       and v_room.current_flag is not null
       and not (v_room.current_flag = any (coalesce(used, '{}'::text[])));

    update public.flag_group_rooms
       set current_flag    = v_next,
           current_flag_at = v_now,
           flag_seq        = flag_seq + 1,
           updated_at      = v_now
     where id = p_room_id and status = 'playing' and flag_seq = p_expected_flag_seq
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.flag_group_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- GERÇEK CLAIM veya DOĞRULANMIŞ TIMEOUT → normal tur ilerlemesi
  v_next_round := v_room.current_round + 1;
  if v_next_round > v_room.total_rounds or v_next is null then
    update public.flag_group_rooms
       set status = 'finished', finished_at = v_now, updated_at = v_now
     where id = p_room_id and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.flag_group_rooms where id = p_room_id;
    end if;
    update public.flag_group_players
       set status = 'finished', last_seen_at = v_now
     where room_id = p_room_id;
    return v_room;
  end if;

  update public.flag_group_room_sequences
     set used = array_append(coalesce(used, '{}'::text[]), v_room.current_flag)
   where room_id = p_room_id
     and v_room.current_flag is not null
     and not (v_room.current_flag = any (coalesce(used, '{}'::text[])));

  update public.flag_group_rooms
     set current_round   = v_next_round,
         current_flag    = v_next,
         current_flag_at = v_now,
         flag_seq        = flag_seq + 1,
         updated_at      = v_now
   where id = p_room_id and status = 'playing' and flag_seq = p_expected_flag_seq
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.flag_group_rooms where id = p_room_id;
  end if;
  return v_room;
end;
$$;

revoke all on function public.flag_group_advance_core(uuid, int, boolean) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) flag_group_advance_if_due — YENİ istemci; odanın HER üyesi çağırabilir
-- ----------------------------------------------------------------------------
-- Yetki genişlemesi DEĞİLDİR: sunucu geçiş anını kilitli satırdan kendi saatiyle
-- okur, sıradaki bayrağı PRIVATE diziden seçer, CAS + satır kilidi ile çift
-- ilerlemeyi imkânsız kılar. Çağıranın yaptırabildiği tek geçiş, sunucunun o an
-- ZATEN yapacağı geçiştir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_advance_if_due(
  p_room_id           uuid,
  p_player_id         uuid,
  p_claim_token       uuid,
  p_expected_flag_seq int
) returns public.flag_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  return public.flag_group_advance_core(p_room_id, p_expected_flag_seq, false);
end;
$$;

-- Misafir (anon) Bayrak Grup oynayabilir → anon EXECUTE ZORUNLU.
revoke all     on function public.flag_group_advance_if_due(uuid, uuid, uuid, int) from public;
grant  execute on function public.flag_group_advance_if_due(uuid, uuid, uuid, int) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) flag_group_advance_flag — GERİYE UYUMLULUK SHIM'İ (REVOKE EDİLMEZ!)
-- ----------------------------------------------------------------------------
-- NEDEN REVOKE DEĞİL: backend migration'ı App Store'daki eski istemciden GÜNLER/
-- HAFTALAR önce canlıya çıkabilir. EXECUTE geri alınsaydı, güncellenmemiş
-- istemcideki host maçı ilerletemez ve Bayrak Grup o istemcilerde TAMAMEN
-- OYNANAMAZ hâle gelirdi. Bu yüzden RPC yaşamaya devam eder:
--
--   • İMZA AYNI          → eski istemci çağrısı derlenir/çalışır.
--   • DÖNÜŞ AYNI         → `flag_group_rooms` satırı; eski istemci `setRoom(data)` yapar.
--   • YETKİ AYNI/GÜÇLÜ   → `flag_group_authorize_host` (host-only). Non-host hâlâ
--                          `unauthorized`; cross-room hâlâ RED (authorize_host
--                          p.room_id = p_room_id şartını taşır). Host-only olması
--                          SPOF DEĞİLDİR: yeni istemciler advance_if_due ile
--                          ilerletmeye devam eder.
--   • `round_active`     → eski erken-advance reddi KORUNUR (bkz. advance_core
--                          p_legacy notu: eski istemcinin retry döngüsü YOK).
--
-- KRİTİK GÜVENLİK FARKI — p_next_flag ARTIK KULLANILMIYOR:
--   Eskiden sıradaki bayrak İSTEMCİDEN geliyordu → host maçın her turunda hangi
--   bayrağın geleceğini SEÇEBİLİYORDU (kolay bayrakları öne alma / bildiği
--   bayrakları sıraya sokma). Biçim guard'ı (^[a-z]{2}$) bunu ENGELLEMİYORDU.
--   Artık parametre KABUL EDİLİR ama OKUNMAZ; hedefi sunucu kendi PRIVATE
--   dizisinden seçer. Eski istemci istediği değeri göndersin — canonical state'e
--   ETKİSİ SIFIRDIR.
--
-- ESKİ DOĞRULAMA RAISE'LERİ (next_flag_invalid / next_flag_unchanged) BİLEREK
-- KALDIRILDI: yok sayılan bir parametreyi doğrulamak yalnızca UYDURMA hata
-- üretebilir. Eski istemcinin RAM havuzu artık sunucunun dizisinden FARKLIDIR;
-- gönderdiği değerin sunucunun current_flag'iyle çakışması `next_flag_unchanged`
-- ile turu kalıcı asabilirdi. Parametre inert olduğu için doğrulama gereksizdir.
--
-- p_next_flag = NULL (eski istemcide "havuzum tükendi" sinyali) da artık ayrı
-- bir anlam taşımaz: havuzun tükenip tükenmediğine SUNUCU kendi dizisine bakarak
-- karar verir (aynı sonuç — küçük bölgelerde finalize).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_advance_flag(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_flag_seq       int,
  p_next_flag      text     -- KABUL EDİLİR, OKUNMAZ (geriye uyumluluk)
) returns public.flag_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- p_next_flag KASTEN yok sayılır (bkz. yukarıdaki güvenlik notu).
  return public.flag_group_advance_core(p_room_id, p_flag_seq, true);
end;
$$;

revoke all     on function public.flag_group_advance_flag(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_group_advance_flag(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) flag_group_finalize_game — ERKEN BİTİRME (GRIEFING) AÇIĞI KAPATILIR
-- ----------------------------------------------------------------------------
-- ESKİ DAVRANIŞ (20260728120000): odanın HERHANGİ bir üyesi, HERHANGİ bir anda
-- çağırıp maçı bitirebiliyordu. Hiçbir deadline/tur kontrolü YOKTU. Yani kaybeden
-- bir oyuncu, tur 2/20'de maçı kapatıp skor tablosunu dondurabilirdi.
--
-- YENİ DAVRANIŞ — yalnız maç GERÇEKTEN bitecekse çalışır:
--   1. Yetki: authorize_player + GERÇEK üyelik (id AND room_id) → cross-room RED,
--      yanlış token RED. (Eskisiyle aynı, korunur.)
--   2. `finished` → idempotent no-op (eskisiyle aynı).
--   3. Oda `playing` değilse → eskisiyle aynı hata.
--   4. GEÇİŞ ANI dolmamışsa → NO-OP (oda değişmeden döner).
--   5. Mevcut bayrak PAS ile çözüldüyse → NO-OP. Pas turu TÜKETMEZ; maç pas ile
--      bitmez (eski istemci de bu durumda çağırmazdı).
--   6. Bitirme ancak "ilerletme zaten finalize edecek olsaydı" doğruysa:
--      son turu geçiyorsak VEYA sıra tükendiyse.
--   Aksi hâlde NO-OP.
--
-- NEDEN RAISE DEĞİL NO-OP: eski istemci bu RPC'yi son turda güvenlik ağı olarak
-- çağırır ve dönüşü KULLANMAZ (yalnız `error` loglanır). NO-OP her iki istemcide
-- de sessiz ve zararsızdır; RAISE ise eski istemcide gereksiz hata gürültüsü
-- üretirdi. Sözleşme bozulmaz.
--
-- KAZANAN/SKOR SEMANTİĞİ DEĞİŞMEDİ: skor `flag_group_claims`ten TÜRETİLİR
-- (gerçek claim sayısı); bu fonksiyon skor/kazanan YAZMAZ, yalnız status/
-- finished_at ve oyuncu status'larını yazar — eskisiyle birebir aynı kolonlar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_finalize_game(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room   public.flag_group_rooms;
  v_now    timestamptz := now();
  v_res    text;
  v_res_at timestamptz;
  v_passed boolean;
  v_due_at timestamptz;
  v_next   text;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Sıra kurulmuş olmalı ki "havuz tükendi mi" sorusu yanıtlanabilsin.
  perform public.flag_group_ensure_sequence(p_room_id);

  select country_code, created_at into v_res, v_res_at
    from public.flag_group_claims
   where room_id  = p_room_id
     and game_seq = v_room.game_seq
     and flag_seq = v_room.flag_seq
   limit 1;

  v_passed := (v_res is not null and v_res like 'pass:%');

  -- Geçiş anı (advance ile AYNI kural; SUNUCU saati).
  if v_res is not null then
    v_due_at := v_res_at
                + make_interval(secs => public.flag_group_reveal_delay_ms() / 1000.0);
  else
    if v_room.current_flag_at is null then
      return v_room;                      -- bilinmeyen tur başlangıcı → dokunma
    end if;
    v_due_at := v_room.current_flag_at
                + make_interval(secs => public.flag_group_flag_timeout_seconds())
                + make_interval(secs => public.flag_group_reveal_delay_ms() / 1000.0);
  end if;

  if v_now < v_due_at then
    return v_room;                        -- ERKEN BİTİRME REDDİ → no-op
  end if;

  -- Pas turu maçı BİTİRMEZ (aynı tur altında yeni bayrak gelir).
  if v_passed then
    return v_room;
  end if;

  -- Ancak ilerletme zaten finalize edecek olsaydı bitir.
  v_next := public.flag_group_next_flag(p_room_id);
  if v_room.current_round + 1 <= v_room.total_rounds and v_next is not null then
    return v_room;                        -- maçın daha turu var → no-op
  end if;

  update public.flag_group_rooms
     set status      = 'finished',
         finished_at = v_now,
         updated_at  = v_now
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.flag_group_rooms where id = p_room_id;
  end if;

  update public.flag_group_players
     set status = 'finished', last_seen_at = v_now
   where room_id = p_room_id;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_finalize_game(uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_finalize_game(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE — doğrulama (Studio SQL editor):
--
--   -- Katalog + sıra tablosu PRIVATE mi?
--   select has_table_privilege('anon','public.flag_group_flag_catalog','select')   as cat_anon,
--          has_table_privilege('anon','public.flag_group_room_sequences','select') as seq_anon;
--   -- Beklenen: her ikisi de FALSE.
--
--   select count(*) from pg_publication_tables
--    where pubname='supabase_realtime' and schemaname='public'
--      and tablename in ('flag_group_flag_catalog','flag_group_room_sequences');
--   -- Beklenen: 0 (sıra realtime ile YAYINLANMAZ).
--
--   -- GERİYE UYUMLULUK: eski istemcinin RPC'si HÂLÂ ÇAĞRILABİLİR olmalı!
--   select has_function_privilege('anon',
--     'public.flag_group_advance_flag(uuid,uuid,uuid,int,text)','execute') as anon_can,
--          has_function_privilege('authenticated',
--     'public.flag_group_advance_flag(uuid,uuid,uuid,int,text)','execute') as auth_can;
--   -- Beklenen: her ikisi de TRUE  (revoke EDİLMEZ — eski istemci bozulmasın).
--
--   -- Yeni RPC misafire açık:
--   select has_function_privilege('anon',
--     'public.flag_group_advance_if_due(uuid,uuid,uuid,int)','execute');
--   -- Beklenen: TRUE.
--
--   -- İki giriş kapısı da TEK otomatı sürüyor; core PRIVATE:
--   select has_function_privilege('anon',
--     'public.flag_group_advance_core(uuid,int,boolean)','execute');
--   -- Beklenen: FALSE.
--
--   select region, count(*) from public.flag_group_flag_catalog group by 1 order by 1;
--   -- Beklenen: africa=54 asia=47 europe=46 north_america=23 oceania=14
--   --           south_america=12 world=196  (toplam 392)
--
-- Smoke (3 oturum — A host, B, C):
--   select * from flag_group_start_game('<room>','<A>','<A tok>', null);
--     -- current_flag SUNUCUDAN gelir (p_first_flag null olsa bile), flag_seq=1
--   select flag_group_advance_if_due('<room>','<B>','<B tok>', 1);
--     -- çözüm yok + 12 sn dolmadı → oda DEĞİŞMEDEN döner (no-op)
--   select flag_group_submit_claim('<room>','<B>','<B tok>', (select current_flag from flag_group_rooms where id='<room>'));
--   -- 2 sn bekle:
--   select flag_group_advance_if_due('<room>','<C>','<C tok>', 1);
--     -- HOST DEĞİL ama ilerletir: round=2, flag_seq=2, yeni current_flag
--   select flag_group_advance_if_due('<room>','<C>','<C tok>', 1);
--     -- bayat flag_seq → no-op (çift ilerletme YOK)
--
-- Karışık sürüm smoke (ESKİ host + YENİ üye aynı odada):
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <flag_seq>, 'zz');
--     -- 'zz' YOK SAYILIR; sunucu kendi dizisinden seçer. Eski istemci başarılı
--     -- bir oda satırı alır (sözleşme korunur), canonical sıra DEĞİŞMEZ.
--   select flag_group_advance_flag('<room>','<B(non-host)>','<B tok>', <fs>, 'us');
--     -- ERROR: unauthorized (eski host-only semantiği KORUNUR)
--
-- Erken bitirme reddi (griefing):
--   select * from flag_group_finalize_game('<room>','<B>','<B tok>');
--     -- tur 2/20'de → oda DEĞİŞMEDEN döner (status hâlâ 'playing')
-- ============================================================================
