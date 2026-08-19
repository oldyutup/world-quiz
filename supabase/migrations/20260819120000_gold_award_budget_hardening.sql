-- ════════════════════════════════════════════════════════════════════════════
-- 20260819120000_gold_award_budget_hardening.sql
--
-- T-03 — award_gameplay_gold: SINIRSIZ REPLAY / FARMING FRENİ
--
-- ════════════════════════════════════════════════════════════════════════════
-- SORUN
-- ─────
-- `award_gameplay_gold` sunucu tarafında DOĞRU olan her şeyi zaten yapıyordu:
--   • auth.uid() zorunlu (misafir/anon gold alamaz)
--   • hedef HER ZAMAN v_uid — istemci profil id GÖNDEREMEZ (çapraz kullanıcı yok)
--   • reason whitelist'i
--   • _apply_gold_delta içinde `profiles ... for update` ile atomik yazım
-- EKSİK olan tek şey FREN'di: idempotency yok, maç bağı yok, cooldown yok,
-- günlük tavan yok ve per-call cap tüm reason'lar için tek bir blanket 500'dü.
-- Kayıtlı bir kullanıcı `award_gameplay_gold(500,'gameplay_award')` çağrısını
-- döngüye alıp sınırsız gold basabiliyordu. (Yalnız kendi hesabı; IAP olmadığı
-- için gelir etkisi yok — ekonomi/kozmetik dengesi etkileniyordu.)
--
-- NEDEN "MAÇ BAĞI" ÇÖZÜM DEĞİL (T-04'ten farkı)
-- ─────────────────────────────────────────────
-- Gold veren reason'ların çoğu TEK OYUNCULU modlardan geliyor (Ülke Yaz solo,
-- Silüet, Bayrak solo, Rota solo). Bu modların SUNUCUDA MAÇ KAYDI YOK —
-- doğrulanacak bir `*_players` satırı mevcut değil. Bu yüzden T-04'teki
-- "katılım doğrula" deseni burada UYGULANAMAZ; fren bütçe/tavan olmak zorunda.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BU MIGRATION NE YAPAR
-- ─────────────────────
--   1) REASON BAZLI per-call cap — blanket 500 kaldırılır. Her reason kendi
--      GERÇEK maksimumuna sabitlenir (aşağıdaki tablo koddan türetildi).
--   2) UTC GÜNLÜK BÜTÇE = 3000 — profil başına, yalnız bu RPC'nin yazdığı
--      reason'lar sayılır.
--   3) anon EXECUTE geri alınır (least-privilege). authenticated KORUNUR.
--
-- NE YAPMAZ: imza değişmez, reason whitelist'i daralmaz, _apply_gold_delta'ya
-- dokunulmaz, RLS/politika/publication değişmez, başka fonksiyon etkilenmez.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PER-CALL CAP'LER — HEPSİ KODDAN TÜRETİLDİ (keyfi sayı yok)
-- ──────────────────────────────────────────────────────────
--   reason                      gerçek max (kaynak)                      cap
--   ─────────────────────────── ──────────────────────────────────────── ────
--   map_match_reward            196 ülke × 2 (GOLD_RATES["map-game"])     400
--                               = 392  → App.tsx:366, countries.ts
--   silhouette_match_reward     196 ülke × 8 (GOLD_RATES)                1600
--                               = 1568 → App.tsx:368, getSilhouettePool
--   flag_match_reward           calcFlagGold = min(band,cap), band max 25   25
--                               → App.tsx:391-403
--   route_match_reward          ROUTE_GOLD.hard.optimal = 40               40
--                               → RouteGame.tsx:33-37
--   gameplay_award              hazine_sandigi = 100 (fate card)          100
--                               → ConquestGame.tsx:2972; liman income = 5
--                                 aynı reason'ı kullanır (addGold default)
--   conquest_fate_card_refund   CONQUEST_FATE_CARD_COST = 200             200
--                               → gold.ts:42
--   conquest_liman_income       LIMAN_INCOME_GOLD = 5                        5
--                               → conquestGameplay.ts:2935
--
-- ⚠ conquest_liman_income'ı istemci ŞU AN HİÇ GÖNDERMİYOR (liman geliri
--   `addGold(LIMAN_INCOME_GOLD)` ile default `gameplay_award` reason'ına
--   düşüyor). Reason whitelist'te KALIYOR (geri uyumluluk) ama gerçek tur
--   ödülü büyüklüğüne (5) sabitlendi — istemcinin buraya 500 göndermesi
--   artık mümkün değil.
--
-- ⚠ BAKIM NOTU: yukarıdaki oyun-içi sabitler değişirse (GOLD_RATES,
--   calcFlagGold bantları, ROUTE_GOLD, fate card ödülleri, ülke havuzu)
--   BU CAP'LER DE GÜNCELLENMELİ. Aksi hâlde meşru ödül sessizce reddedilir.
--
-- ════════════════════════════════════════════════════════════════════════════
-- GÜNLÜK BÜTÇE = 3000 / profil / UTC gün
-- ──────────────────────────────────────
-- Canlı kalibrasyon (son 30 gün): gözlenen EN YÜKSEK gerçek günlük
-- `source='gameplay'` toplamı = 31 gold/gün/oyuncu.
--
-- 3000 bilinçli olarak ÇOK konservatif seçildi çünkü teorik meşru tavan
-- gözlemden kat kat yüksek: TEK bir tam Silüet oturumu 196×8 = 1568 gold
-- üretebilir; güçlü ama gerçekçi bir oturum ~480-640 (60-80 doğru cevap).
-- 2-3 güçlü Silüet oturumu ≈ 1300-2000 → 1000'lik bir tavan MEŞRU ağır
-- oyuncuyu keserdi. 3000, gözlenen gerçek maksimumun ~100 katı ve teorik
-- meşru günün de üstünde → yanlış pozitif riski pratikte sıfır.
-- Saldırı tarafında ise "sınırsız" → "günde 3000" olur; per-call cap'lerle
-- birlikte farming'in pratik değeri biter.
--
-- HANGİ SATIRLAR SAYILIR (dar kapsam — kasıtlı)
--   ✔ source='gameplay' VE amount>0 VE reason ∈ bu RPC'nin whitelist'i
--   ✘ daily_bonus       (source='daily')        → günlük 50 gold bonusu
--   ✘ daily_quest_reward(source='daily_quest')  → Günün Görevi
--   ✘ achievement_reward(source='gameplay' AMA farklı reason) → başarımlar
--   ✘ harcamalar (amount<0, spend_gameplay_gold)
-- Yani bütçe YALNIZ bu RPC'nin bastığı gold'u yönetir; diğer ekonomi
-- akışları yanlışlıkla bloklanmaz. (achievement_reward source='gameplay'
-- kullandığı için source tek başına yeterli DEĞİLDİ — reason filtresi şart.)
--
-- ════════════════════════════════════════════════════════════════════════════
-- YARIŞ GÜVENLİĞİ (concurrency)
-- ─────────────────────────────
-- Bütçe kontrolü ile yazım arasında TOCTOU penceresi kalmaması için, sayım
-- YAPILMADAN ÖNCE profil satırı `for update` ile kilitlenir. `_apply_gold_delta`
-- zaten AYNI satırı kilitliyor (reentrant, aynı transaction) → aynı profile
-- ait eşzamanlı tüm çağrılar bu satırda serialize olur ve "kontrol + yazım"
-- atomik hâle gelir. Paralel 10 çağrı bütçeyi AŞAMAZ.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ESKİ APP STORE İSTEMCİSİ İLE UYUM
-- ─────────────────────────────────
-- İmza (int, text, jsonb) ve dönüş şekli { ok, gold, amount, code? } AYNEN
-- korundu. Reddedilen çağrı ZATEN desteklenen bir durum:
--   gold.ts:174-190 → `ok:false` ise rpcAward null döner
--   gold.ts:236-243 → addGold optimistic artışı geri alır
-- Yani yeni `daily_cap_reached` / daraltılmış `amount_exceeds_cap` kodlarını
-- eski binary de sorunsuz karşılar (çökme yok, sadece gold eklenmez).
-- `amount_exceeds_cap` kod ADI bilerek korundu — yeni bir kod adı uydurmak
-- yerine mevcut sözleşme kullanıldı.
--
-- ANON EXECUTE REVOKE — neden güvenli
--   `addGold` RPC'yi YALNIZ `if (activeProfileId)` iken çağırır (gold.ts:236),
--   yani misafir/anon bu kod yoluna HİÇ girmez. Girseydi bile gövde zaten
--   `ok:false, unauthenticated` dönüyordu. Revoke sonrası anon 42501 alır ve
--   istemci bunu `error` dalında yutar → kullanıcıya görünür fark YOK.
--   PUBLIC üzerinden grant OLMADIĞI precheck'te doğrulandı; yine de simetri
--   için hem anon hem public yazılır (20260808/20260815 dersi).
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.award_gameplay_gold(
  p_amount   int,
  p_reason   text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid        uuid := auth.uid();
  -- Whitelist DEĞİŞMEDİ (geri uyumluluk): mevcut canlı gövdeyle birebir aynı.
  v_allowed    text[] := array[
    'map_match_reward',
    'silhouette_match_reward',
    'flag_match_reward',
    'route_match_reward',
    'conquest_liman_income',
    'conquest_fate_card_refund',
    'gameplay_award'
  ];
  v_reason_cap int;
  v_daily_cap  int := 3000;
  v_used_today int;
  v_new        int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;
  if not (p_reason = any(v_allowed)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_reason');
  end if;

  -- ── 1) REASON BAZLI per-call cap (blanket 500 KALDIRILDI) ───────────────
  v_reason_cap := case p_reason
    when 'map_match_reward'          then  400   -- 196 ülke × 2
    when 'silhouette_match_reward'   then 1600   -- 196 ülke × 8
    when 'flag_match_reward'         then   25   -- calcFlagGold band max
    when 'route_match_reward'        then   40   -- ROUTE_GOLD.hard.optimal
    when 'conquest_liman_income'     then    5   -- LIMAN_INCOME_GOLD
    when 'conquest_fate_card_refund' then  200   -- CONQUEST_FATE_CARD_COST
    when 'gameplay_award'            then  100   -- hazine_sandigi (fate card)
    else 0
  end;

  if p_amount > v_reason_cap then
    -- Kod adı bilerek korundu: eski istemci sözleşmesi.
    return jsonb_build_object(
      'ok', false, 'code', 'amount_exceeds_cap', 'cap', v_reason_cap
    );
  end if;

  -- ── 2) Profil satırını KİLİTLE — bütçe sayımı + yazım atomik olsun ──────
  --    _apply_gold_delta aynı satırı yeniden kilitler (aynı transaction →
  --    reentrant). Profil yoksa aşağıdaki delta çağrısı eskisi gibi
  --    'no_profile' fırlatır; davranış değişmedi.
  perform 1 from public.profiles where id = v_uid for update;

  -- ── 3) UTC günlük bütçe — YALNIZ bu RPC'nin yazdığı satırlar ────────────
  select coalesce(sum(amount), 0)::int
    into v_used_today
    from public.gold_transactions
   where profile_id = v_uid
     and amount     > 0
     and source     = 'gameplay'
     and reason     = any(v_allowed)
     and created_at >= (date_trunc('day', (now() at time zone 'utc')) at time zone 'utc');

  if v_used_today + p_amount > v_daily_cap then
    return jsonb_build_object(
      'ok',   false,
      'code', 'daily_cap_reached',
      'cap',  v_daily_cap,
      'used', v_used_today
    );
  end if;

  -- ── 4) Yazım — mevcut atomik yol AYNEN korundu ──────────────────────────
  v_new := public._apply_gold_delta(
    v_uid, p_amount, p_reason, 'gameplay', coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object('ok', true, 'gold', v_new, 'amount', p_amount);
end
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
-- GRANTS — anon least-privilege, authenticated KORUNUR
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on function public.award_gameplay_gold(int, text, jsonb) from anon;
revoke execute on function public.award_gameplay_gold(int, text, jsonb) from public;
grant  execute on function public.award_gameplay_gold(int, text, jsonb) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA — hedefler tuttu mu VE korunması gerekenler duruyor mu
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fail text := '';
begin
  -- (1) fonksiyon hâlâ var ve sertleştirilmiş
  if to_regprocedure('public.award_gameplay_gold(int,text,jsonb)') is null then
    v_fail := v_fail || ' [award_gameplay_gold imzası KAYBOLDU]';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'award_gameplay_gold'
       and p.prosecdef
       and p.proconfig is not null
       and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  ) then
    v_fail := v_fail || ' [SECURITY DEFINER veya search_path kayboldu]';
  end if;

  -- (2) authenticated KORUNDU (meşru ödül akışı bu grant'a bağlı)
  if not has_function_privilege('authenticated',
        'public.award_gameplay_gold(int,text,jsonb)', 'EXECUTE') then
    v_fail := v_fail || ' [authenticated EXECUTE KAYBOLDU — gold ödülleri kırılır]';
  end if;

  -- (3) anon gerçekten kapandı (PUBLIC üzerinden sızmıyor)
  if has_function_privilege('anon',
        'public.award_gameplay_gold(int,text,jsonb)', 'EXECUTE') then
    v_fail := v_fail || ' [anon EXECUTE HÂLÂ AÇIK]';
  end if;

  -- (4) bağımlı yardımcı yerinde ve istemciye kapalı
  if to_regprocedure('public._apply_gold_delta(uuid,int,text,text,jsonb)') is null then
    v_fail := v_fail || ' [_apply_gold_delta BULUNAMADI]';
  end if;
  if has_function_privilege('authenticated',
        'public._apply_gold_delta(uuid,int,text,text,jsonb)', 'EXECUTE') then
    v_fail := v_fail || ' [_apply_gold_delta authenticated''a AÇILMIŞ — olmamalı]';
  end if;

  -- (5) gold_transactions bütçe sorgusu için gerekli kolonlar duruyor
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'gold_transactions'
       and column_name in ('profile_id','amount','source','reason','created_at')
     group by table_name having count(*) = 5
  ) then
    v_fail := v_fail || ' [gold_transactions bütçe kolonları eksik]';
  end if;

  -- (6) gameplay DIŞI ekonomi akışları bütçeye girmiyor olmalı:
  --     daily_bonus source='daily', daily_quest_reward source='daily_quest'.
  --     Bu satırlar reason filtresine de takılmaz (whitelist'te yoklar).
  if exists (
    select 1 from public.gold_transactions
     where reason in ('daily_bonus','daily_quest_reward')
       and source = 'gameplay'
  ) then
    v_fail := v_fail || ' [daily_bonus/daily_quest source=gameplay ile yazılmış — bütçe kapsamı gözden geçirilmeli]';
  end if;

  if v_fail <> '' then
    raise exception 'T-03 DOĞRULAMA BAŞARISIZ:%', v_fail;
  end if;

  raise notice 'OK (T-03): reason bazlı per-call cap + 3000/UTC-gün bütçesi aktif; imza, reason whitelist''i, _apply_gold_delta ve authenticated EXECUTE değişmedi.';
end $$;
