-- ============================================================================
-- Kör Nokta — select_questions / fill_questions ONARIM (idempotent re-apply)
-- ============================================================================
-- Canlı testte dedektifin soru seçimi her çağrıda "Soru seçimin kaydedilemedi"
-- (jenerik, eşlenmemiş) hatasıyla başarısız oluyordu. Teşhis: oyun BAŞLIYOR ve
-- 12 aday soru render ediliyor → 20260718'in build_round + start_game'i canlıda
-- (yeni client kategori-sözlüğü havuzunu ancak yeni start_game kabul eder).
-- Buna rağmen select_questions eşlenmemiş bir hata fırlatıyor; repo'daki kanonik
-- gövde bunu ÜRETEMEZ. En olası neden: 20260718 migration'ı canlıya ARA/BOZUK
-- bir taslakla uygulanmış (select_questions eski/elle düzenlenmiş sürümde kalmış)
-- ve aynı dosya adı tekrar push'ta atlandığı için onarılmamış.
--
-- Bu migration TAZE timestamp ile select_questions ve fill_questions'ı 20260718'
-- deki KANONİK gövdeyle yeniden yazar (CREATE OR REPLACE → idempotent). Zaten
-- doğruysa no-op; bozuksa canlıyı repo ile hizalar. İmza/şema/akış DEĞİŞMEDİ;
-- yalnız round.questionCandidates'a dayanan server-otoriter doğrulama garanti
-- edilir. build_round / start_game / submit_answer / advance / puanlama'ya
-- DOKUNULMADI (onlar zaten doğru çalışıyor).
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
  v_clean := coalesce((
    select jsonb_agg(t.val order by t.ord)
      from jsonb_array_elements_text(p_question_ids) with ordinality as t(val, ord)
     where (v_cands ? t.val)
       and t.ord = (
         select min(t2.ord)
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


-- ────────────────────────────────────────────────────────────────────────────
-- tevatur_kn_fill_questions — eksik seçimi turun ADAY setinden 5'e tamamlar
-- ----------------------------------------------------------------------------
-- observe_report kapanırken çağrılır. Mevcut seçim KORUNUR; eksik kalan kadar
-- YALNIZ round.questionCandidates'tan (henüz seçilmemiş) rasgele soru eklenir.
-- Böylece fallback dedektifin görmediği bir soru ASLA enjekte etmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_fill_questions(
  p_state jsonb
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_idx   int   := (p_state->>'roundIndex')::int;
  v_round jsonb := p_state->'rounds'->v_idx;
  v_cands jsonb := coalesce(v_round->'questionCandidates', '[]'::jsonb);
  v_team  text;
  v_sel   jsonb;
  v_need  int;
  v_fill  text[];
begin
  foreach v_team in array array['blue', 'red'] loop
    v_sel := v_round->'selectedQuestions'->v_team;
    if v_sel is null or jsonb_typeof(v_sel) <> 'array' then
      v_sel := '[]'::jsonb;
    end if;
    v_need := 5 - jsonb_array_length(v_sel);
    if v_need > 0 then
      v_fill := array(
        select q from (
          select jsonb_array_elements_text(v_cands) as q
        ) s
        where not (v_sel ? s.q)
        order by random()
        limit v_need
      );
      if coalesce(array_length(v_fill, 1), 0) > 0 then
        v_sel := v_sel || to_jsonb(v_fill);
      end if;
    end if;
    v_round := jsonb_set(v_round, array['selectedQuestions', v_team], v_sel);
  end loop;
  return jsonb_set(p_state, array['rounds', v_idx::text], v_round);
end;
$$;

revoke all on function public.tevatur_kn_fill_questions(jsonb) from public;
grant execute on function public.tevatur_kn_fill_questions(jsonb) to authenticated;


-- ============================================================================
-- DONE — select_questions / fill_questions repo ile hizalandı (idempotent).
-- Yeni odada: dedektif 12 adaydan ≤5 seçer → selectedQuestions[team] yazılır →
-- raporcular/casuslar bu seçili soruları görür. Eski odalar (questionCandidates
-- içermeyen) DESTEKLENMEZ; client artık bunu açık mesajla bildirir.
-- ============================================================================
