-- ============================================================================
-- Conquest Kader Karti — spend reason whitelist genisletmesi
-- ============================================================================
-- Amac:
--   Kusatma modunda Kader Karti cekimi 200 Gold maliyetli hale getirildi.
--   Client tarafi `spend_gameplay_gold` RPC'sini `reason = 'conquest_fate_card'`
--   ile cagiriyor. Mevcut whitelist bu reason'i icermedigi icin RPC
--   'invalid_reason' donuyordu — bu migration whitelist'e ekler.
--
-- Etki:
--   - `spend_gameplay_gold` artik 'conquest_fate_card' reason'ini kabul eder.
--   - Cap (500) ve `_apply_gold_delta` mantigi degismedi.
--   - Diger reason'lar ve fonksiyon imzasi degismedi.
--
-- Idempotency:
--   `create or replace function` ile fonksiyon yeniden tanimlanir.
-- ============================================================================

create or replace function public.spend_gameplay_gold(
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
  v_uid     uuid := auth.uid();
  v_allowed text[] := array[
    'hint_first_letter',
    'hint_letter_count',
    'hint_continent',
    'hint_region',
    'hint_coast',
    'hint_neighbors',
    'hint_silhouette',
    'hint_generic',
    'conquest_fate_card',
    'gameplay_spend'  -- generic fallback for gameplay-side spends
  ];
  v_max     int  := 500;
  v_new     int;
  v_cur     int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;
  if p_amount > v_max then
    return jsonb_build_object('ok', false, 'code', 'amount_exceeds_cap', 'cap', v_max);
  end if;
  if not (p_reason = any(v_allowed)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_reason');
  end if;

  begin
    v_new := public._apply_gold_delta(
      v_uid, -p_amount, p_reason, 'gameplay', coalesce(p_metadata, '{}'::jsonb)
    );
  exception when sqlstate '23514' then
    select coalesce(gold, 0) into v_cur from public.profiles where id = v_uid;
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_gold', 'gold', coalesce(v_cur, 0)
    );
  end;

  return jsonb_build_object('ok', true, 'gold', v_new, 'amount', p_amount);
end
$fn$;

revoke all   on function public.spend_gameplay_gold(int, text, jsonb) from public;
grant execute on function public.spend_gameplay_gold(int, text, jsonb) to authenticated;
