-- ============================================================================
-- Kör Nokta — select_questions ORDINALITY ALIAS ONARIMI (kesin runtime fix)
-- ============================================================================
-- Canlı console hatası (dedektif soru seçince):
--   POST .../rpc/tevatur_kn_select_questions 400
--   code: 42703  message: column "t2.ord" does not exist
--   hint: Perhaps you meant "t2.ord2" or "t.ord".
--
-- KÖK NEDEN: select_questions içindeki tekilleştirme (dedup) altsorgusu. Dış
-- tablo `with ordinality as t(val, ord)` → kolonlar t.val / t.ord. İç korelasyonlu
-- altsorgu ise `with ordinality as t2(val2, ord2)` ile kolonları YENİDEN
-- adlandırıyor (ordinality = ord2). Ama gövde `min(t2.ord)` okuyor — ki bu kolon
-- YOK. Postgres hint'i tam da bunu söylüyor (doğru alias: t2.ord2).
--
-- NEDEN ÖNCEKİ REPAIR YAKALAMADI: Bu kanonik gövde 20260717/20260718120000/
-- 20260718130000'in ÜÇÜNDE de aynı latent hatayı taşıyordu. PL/pgSQL gövdesindeki
-- gömülü SQL sorguları CREATE OR REPLACE anında PLANLANMAZ (kolon çözümü ilk
-- çağrıya ertelenir / SPI plan lazy hazırlanır). Bu yüzden her migration TEMİZ
-- uygulandı ama dedektif fonksiyonu İLK kez çağırdığında 42703 fırladı. Sadece
-- dosya düzeltmek bu yüzden yetmiyor; canlıyı yeniden yazan TAZE timestamp şart.
--
-- DÜZELTME: `min(t2.ord)` → `min(t2.ord2)`. Tek değişiklik bu. İmza/şema/akış,
-- sıralama (order by t.ord), ilk-konum tekilleştirme, server-otoriter aday
-- doğrulaması — HEPSİ AYNI. fill_questions denetlendi: WITH ORDINALITY yok,
-- alias hatası yok → DOKUNULMADI. build_round / start_game / submit_answer /
-- advance / harita tahmini / puanlama / scene / 360 / app-native DOKUNULMADI.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- tevatur_kn_select_questions — dedektif seçimi; turun ADAY setine göre doğrular
-- ----------------------------------------------------------------------------
-- Dedektif yalnız o turun 12 adayını (round.questionCandidates) görür; gönderilen
-- id'lerden ADAY dışı kalanlar elenir, sıra korunur, ilk görülen konum tutulur.
-- Server-otoriter tek doğru kaynak: selectedQuestions[team] daima adayların altkümesi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_select_questions(
  p_room_id      uuid,
  p_player_id    uuid,
  p_claim_token  uuid,
  p_question_ids jsonb
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
  v_cands jsonb;
  v_pid   text := p_player_id::text;
  v_team  text;
  v_clean jsonb;
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
  if v_state->>'phase' <> 'observe_report' then
    raise exception 'wrong_phase' using errcode = 'P0001';
  end if;

  v_idx   := (v_state->>'roundIndex')::int;
  v_round := v_state->'rounds'->v_idx;
  v_cands := coalesce(v_round->'questionCandidates', '[]'::jsonb);

  if v_round->'detectives'->>'blue' = v_pid then
    v_team := 'blue';
  elsif v_round->'detectives'->>'red' = v_pid then
    v_team := 'red';
  else
    raise exception 'not_detective' using errcode = 'P0001';
  end if;

  if p_question_ids is null
     or jsonb_typeof(p_question_ids) <> 'array'
     or jsonb_array_length(p_question_ids) > 5 then
    raise exception 'questions_invalid' using errcode = '22023';
  end if;

  -- Sıra korunur; aynı id'nin ilk görüldüğü konum tutulur; ADAY dışı id atılır.
  -- NOT: iç tablo `t2(val2, ord2)` ile yeniden adlandırılır → ordinality = ord2.
  v_clean := coalesce((
    select jsonb_agg(t.val order by t.ord)
      from jsonb_array_elements_text(p_question_ids) with ordinality as t(val, ord)
     where (v_cands ? t.val)
       and t.ord = (
         select min(t2.ord2)
           from jsonb_array_elements_text(p_question_ids) with ordinality as t2(val2, ord2)
          where t2.val2 = t.val
       )
  ), '[]'::jsonb);

  v_round := jsonb_set(v_round, array['selectedQuestions', v_team], v_clean);
  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_select_questions(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.tevatur_kn_select_questions(uuid, uuid, uuid, jsonb) to authenticated;


-- ============================================================================
-- DONE — `min(t2.ord)` → `min(t2.ord2)`. select_questions artık ilk çağrıda
-- 42703 fırlatmaz; dedektif ≤5 soru seçer → selectedQuestions[team]'e DOĞRU
-- SIRAYLA yazılır → raporcular & casuslar aynı seçili soruları görür. Casus
-- routing reportOrder ile değişmez. fill_questions zaten temizdi (dokunulmadı).
-- ============================================================================
