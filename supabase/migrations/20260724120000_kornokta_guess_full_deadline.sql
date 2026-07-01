-- ============================================================================
-- Kör Nokta — konum tahmini (detective_guess) DAİMA 35 sn deadline'ı bekler
-- ============================================================================
-- Amaç: detective_guess fazı, iki dedektif de tahminini erken göndermiş olsa
-- bile round_reveal'e ERKEN GEÇMESİN. Faz yalnız ortak 35 sn'lik phaseEndsAt
-- deadline'ı dolunca (host-authoritative tevatur_kn_advance_phase → apply_round)
-- kapansın.
--
-- ÖNCE (20260714123000): tevatur_kn_submit_guess, ikinci dedektifin tahmini de
-- kaydedildiğinde `if blue ve red guess var → apply_round` bloğuyla fazı hemen
-- round_reveal'e taşıyordu. Otomatik pin-bırak-kaydet (client) ile birlikte bu,
-- iki dedektif ilk saniyelerde pin bırakırsa turu ~5 sn'de bitirebiliyordu.
--
-- SONRA (bu migration): submit_guess YALNIZ tahmini kaydeder (idempotent
-- 'already_submitted' + faz/rol guard'ları AYNI kalır) ve fazı DEĞİŞTİRMEZ.
-- Her iki tahmin de güvenle game_state.rounds[idx].guesses altında saklanır;
-- oyuncular "Tahmin kilitlendi / süre bekleniyor" durumunu görür. round_reveal'e
-- geçiş TEK yoldan olur: süre dolunca advance_phase'in çağırdığı apply_round.
--
-- DOKUNULMAYANLAR (bilinçli):
--   • answer_questions erken tamamlama (submit_answer "herkes cevapladı" →
--     detective_guess) AYNEN kalır — yalnız konum tahmini fazı tam süre bekler.
--   • apply_round (sonuç/skor/totals hesabı) mantığı değişmedi; yalnız ARTIK
--     tek çağıranı advance_phase'in deadline dalıdır → sonuç bir kez hesaplanır.
--   • 35 sn tek-kaynak yapısı (tevatur_kn_phase_duration_ms), advance_phase,
--     phaseEndsAt kurulumu, host timer + expected-round/phase guard + FOR UPDATE
--     satır kilidi AYNI.
--   • İmza değişmedi: (uuid, uuid, uuid, double precision, double precision).
--     Client ek değişiklik gerektirmez; RPC dönüşü hâlâ güncel tevatur_rooms.
--
-- Gövde 20260714123000'daki sürümün BİREBİR kopyasıdır; TEK fark, "iki dedektif
-- de gönderdiyse apply_round" bloğunun KALDIRILMASIDIR.
-- ============================================================================

create or replace function public.tevatur_kn_submit_guess(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_lat         double precision,
  p_lng         double precision
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.tevatur_rooms;
  v_state jsonb;
  v_idx   int;
  v_round jsonb;
  v_pid   text := p_player_id::text;
  v_team  text;
  v_lng   double precision;
  v_guess jsonb;
begin
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' or v_room.game_state is null then
    raise exception 'game_not_active' using errcode = 'P0001';
  end if;

  v_state := v_room.game_state;
  if v_state->>'phase' <> 'detective_guess' then
    raise exception 'wrong_phase' using errcode = 'P0001';
  end if;

  v_idx   := (v_state->>'roundIndex')::int;
  v_round := v_state->'rounds'->v_idx;

  if v_round->'detectives'->>'blue' = v_pid then
    v_team := 'blue';
  elsif v_round->'detectives'->>'red' = v_pid then
    v_team := 'red';
  else
    raise exception 'not_detective' using errcode = 'P0001';
  end if;

  -- Çift-submit / lag re-delivery koruması: bu takım zaten gönderdiyse reddet
  -- (çift skor olmaz). Client guard'ıyla birlikte iki katman idempotency.
  if jsonb_typeof(v_round->'guesses'->v_team) = 'object' then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90
     or p_lng not between -100000 and 100000 then
    raise exception 'guess_required' using errcode = '22023';
  end if;
  -- worldCopyJump pan'i ±180 dışına taşıyabilir → normalize et.
  v_lng := ((p_lng + 180.0) - 360.0 * floor((p_lng + 180.0) / 360.0)) - 180.0;

  v_guess := jsonb_build_object('lat', p_lat, 'lng', v_lng);
  v_round := jsonb_set(v_round, array['guesses', v_team], v_guess);
  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);

  -- NOT: İki dedektif de göndermiş olsa bile faz BURADA ilerlemez. Konum tahmini
  -- fazı tam 35 sn açık kalır; round_reveal'e geçiş yalnız süre dolunca
  -- advance_phase (→ apply_round) ile bir kez yapılır. (Eski "her ikisi gönderdi
  -- → apply_round" erken-geçiş bloğu bilinçli olarak kaldırıldı.)

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) from public;
grant execute on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) to authenticated;

-- ============================================================================
-- DONE — detective_guess artık erken kapanmaz. İki tahmin de kaydedilir, pinler
-- kilitli kalır, faz 35 sn deadline'ıyla advance_phase üzerinden round_reveal'e
-- geçer (sonuç bir kez hesaplanır). submit_answer erken tamamlaması ve 35 sn tek
-- kaynak yapısı değişmedi. Client ile uyumludur (imza aynı).
-- ============================================================================
