-- ============================================================================
-- Conquest Kader Karti — refund reason whitelist genisletmesi
-- ============================================================================
-- Amac:
--   Kusatma modunda Kader Karti cekimi `spend_gameplay_gold` ile 200 Gold
--   harciyor. Spend basariyla finalize olduktan sonra (post-spend) yapilan
--   eligibility re-check'i veya state push asamasi basarisiz olursa client
--   200 Gold'u `award_gameplay_gold` ile geri iade ediyor. Refund reason'i
--   `conquest_fate_card_refund` whitelist'te yer almadigi icin RPC
--   'invalid_reason' donuyordu — bu migration whitelist'e ekler.
--
-- Etki:
--   - `award_gameplay_gold` artik 'conquest_fate_card_refund' reason'ini kabul eder.
--   - Cap (500) ve `_apply_gold_delta` mantigi degismedi.
--   - Diger reason'lar ve fonksiyon imzasi degismedi.
--
-- Idempotency:
--   `create or replace function` ile fonksiyon yeniden tanimlanir.
-- ============================================================================

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
  v_uid     uuid := auth.uid();
  v_allowed text[] := array[
    'map_match_reward',
    'silhouette_match_reward',
    'flag_match_reward',
    'route_match_reward',
    'conquest_liman_income',
    'conquest_fate_card_refund',
    'gameplay_award'  -- generic fallback (gameplay files lacking a specific reason)
  ];
  v_max     int  := 500;
  v_new     int;
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

  v_new := public._apply_gold_delta(
    v_uid, p_amount, p_reason, 'gameplay', coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object('ok', true, 'gold', v_new, 'amount', p_amount);
end
$fn$;

revoke all   on function public.award_gameplay_gold(int, text, jsonb) from public;
grant execute on function public.award_gameplay_gold(int, text, jsonb) to authenticated;
