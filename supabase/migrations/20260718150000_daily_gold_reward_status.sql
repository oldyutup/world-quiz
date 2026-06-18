-- ============================================================================
-- Günlük Gold Bonusu — durum sorgusu (Bildirimler paneli kartı için)
-- ============================================================================
-- Amac:
--   Bildirimler panelinde "Günlük bonusun hazır" aksiyon kartını göstermek
--   icin SERVER-OTORITELI bir durum sorgusu. Tek kaynak DEGISMEDI: gerçek
--   claim hâlâ public.claim_daily_gold_bonus() üzerinden yapılır ve günlük
--   uygunluk yalnızca public.gold_transactions (reason='daily_bonus') üzerinden
--   belirlenir. Bu fonksiyon HİÇBİR yazma yapmaz; sadece okur.
--
-- Neden ayrı/sentetik kart (yeni notifications satırı DEĞİL):
--   - claim_daily_gold_bonus zaten idempotent + atomik (profil satırı FOR UPDATE
--     + aynı UTC günü icin reason='daily_bonus' kaydı kontrolü). Tek kaynak budur.
--   - Notifications tablosuna "günlük bonus" satırı yazmak için bir zamanlayıcı
--     (cron) + backfill + duplicate koruması + read/clear semantiği ile uğraşmak
--     gerekirdi. Bunun yerine kart, bu durum RPC'sinden türetilir:
--       * Aynı dönem icin asla çift "bildirim" oluşmaz (sentetik, satır yok).
--       * Mevcut kullanıcılar deploy sonrası BEKLEMEDEN doğru durumu görür
--         (geriye dönük; backfill gerekmez).
--       * Panel acmak / "tümünü okundu yap" bonusu "çözüldü" saymaz; kart yalnız
--         Gold alınınca (claim) kaybolur.
--   - 24 saat / gün sınırı client saatiyle DEĞİL, server zamanı + DB kaydı ile
--     belirlenir.
--
-- Donus (jsonb):
--   { ok, available, available_at, server_now }
--     available     : bugün (UTC) daily_bonus alınmadıysa true
--     available_at  : available ise server_now; değilse bir sonraki UTC gün başı
--                     (bonusun yeniden alınabilir olacağı an) — client hafif
--                     yenileme zamanlayıcısı bunu kullanır
--     server_now    : sunucu saati (client saatine güvenmemek icin)
--
-- Idempotent (create or replace). search_path sabit. claim_daily_gold_bonus ile
-- AYNI pencere ifadesi kullanılır ki iki fonksiyon her zaman aynı fikirde olsun.
-- ============================================================================

create or replace function public.daily_gold_reward_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid         uuid := auth.uid();
  v_today_start timestamptz;
  v_today_end   timestamptz;
  v_count       int;
  v_available   boolean;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'unauthenticated', 'available', false
    );
  end if;

  -- claim_daily_gold_bonus() ile BİREBİR aynı pencere ifadesi.
  v_today_start := date_trunc('day', timezone('UTC', now()));
  v_today_end   := v_today_start + interval '1 day';

  select count(*) into v_count
    from public.gold_transactions
   where profile_id = v_uid
     and reason     = 'daily_bonus'
     and created_at >= v_today_start
     and created_at <  v_today_end;

  v_available := (v_count = 0);

  return jsonb_build_object(
    'ok',           true,
    'available',    v_available,
    'available_at', case when v_available then now() else v_today_end end,
    'server_now',   now()
  );
end
$fn$;

revoke all on function public.daily_gold_reward_status() from public;
grant  execute on function public.daily_gold_reward_status() to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor, bir test kullanıcısının JWT'siyle):
--   select public.daily_gold_reward_status();
--   -- claim öncesi: available=true, available_at≈now
--   select public.claim_daily_gold_bonus();
--   select public.daily_gold_reward_status();
--   -- claim sonrası: available=false, available_at = yarın 00:00 UTC
-- ============================================================================
