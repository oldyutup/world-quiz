-- ============================================================================
-- Kör Nokta — Gizli-kategori dengeli 12 aday soru (game_state version 3, revize)
-- ============================================================================
-- Soru-cevap akışını (20260717120000) iki noktada revize eder:
--
--   1) KRİTİK ROUTING FİX — "seçilen sorular raporculara yanlış gidiyor".
--      Eski akışta dedektifin GÖRDÜĞÜ aday seti client'ta (shuffleQuestions) tüm
--      30-soru havuzundan üretiliyor, server'a YAZILMIYORDU; tevatur_kn_fill_questions
--      ise eksik seçimi TÜM havuzdan (questionPool, 30 soru) rasgele tamamlıyordu.
--      Böylece "tek doğru kaynak" yoktu: dedektifin seçimi tam kalıcı olmazsa
--      (kısmî/geç yazım) fallback, dedektifin HİÇ görmediği sorular enjekte ediyor,
--      bunlar raporculara "alakasız sorular" olarak düşüyordu.
--
--      Çözüm: turun aday seti artık SERVER-OTORİTER ve KALICI. build_round her tur
--      bir kez round.questionCandidates üretir (3/kategori × 4 = 12, karışık).
--      Dedektif gösterimi, seçim doğrulaması ve fallback tamamlama YALNIZ bu sete
--      dayanır. İki takım dedektifi de AYNI 12 adayı görür (adil + basit).
--      fill_questions mevcut seçimi KORUR, eksiği yalnız adaylardan tamamlar.
--
--   2) GİZLİ KATEGORİ DENGESİ — soru havuzu artık {alphabet, traffic, architecture,
--      nature} kategorilerine ayrılmış bir sözlük (her kategoride ≥8 soru). Her tur
--      HER kategoriden 3 soru çekilip 12 karıştırılır; kategori başlıkları UI'da
--      gösterilmez (client yalnız 12 karışık kart gösterir). Determinizm: build_round
--      bir kez random çalışıp sonucu state'e yazdığı için aynı turda refresh/reconnect
--      AYNI 12 soru + sırayı döndürür; yeni turda yeniden üretilir.
--
-- Değişen fonksiyonlar: tevatur_kn_build_round, tevatur_kn_fill_questions,
-- tevatur_kn_select_questions, tevatur_kn_start_game (imza AYNI; p_question_pool
-- artık string[] DEĞİL, kategori→id[] sözlüğü). Casus routing (reportOrder),
-- submit_answer, advance_phase, apply_round, puanlama, scene seçimi DEĞİŞMEDİ.
-- Client (korNoktaQuestions + korNoktaGameTypes + KorNoktaGame) ile BİRLİKTE deploy.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_build_round — round.questionCandidates üretir (3/kategori, karışık)
-- ----------------------------------------------------------------------------
-- v2/v3 ile AYNI rol/casus/reportOrder mantığı; EK olarak state.questionPool
-- (kategori→id[]) sözlüğünden her kategoriden 3 soru çeker, 12'yi karıştırıp
-- round.questionCandidates'a yazar. Sonuç KALICI (tur boyu sabit, refresh-stabil).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_build_round(
  p_state       jsonb,
  p_round_index int
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_mole_enabled boolean := coalesce((p_state->>'moleEnabled')::boolean, false);
  v_scene        jsonb   := p_state->'scenes'->p_round_index;
  v_qpool        jsonb   := coalesce(p_state->'questionPool', '{}'::jsonb);
  v_blue         text[]  := array(select jsonb_array_elements_text(p_state->'teams'->'blue'));
  v_red          text[]  := array(select jsonb_array_elements_text(p_state->'teams'->'red'));
  v_blue_order   text[]  := array(select jsonb_array_elements_text(p_state->'detectiveOrder'->'blue'));
  v_red_order    text[]  := array(select jsonb_array_elements_text(p_state->'detectiveOrder'->'red'));
  v_det_b        text;
  v_det_r        text;
  v_rep_b        text[];
  v_rep_r        text[];
  v_mole_b       text := null;
  v_mole_r       text := null;
  v_honest_b     text[];
  v_honest_r     text[];
  v_all_reporters text[];
  v_pref_cats    text[];
  v_rest_cats    text[];
  v_cats         text[];
  v_assignments  jsonb := '{}'::jsonb;
  v_order_b      text[];
  v_order_r      text[];
  v_qcat         text;
  v_qpick        text[];
  v_cands        jsonb := '[]'::jsonb;
  v_n            int;
  i              int;
begin
  v_det_b := v_blue_order[(p_round_index % array_length(v_blue_order, 1)) + 1];
  v_det_r := v_red_order[(p_round_index % array_length(v_red_order, 1)) + 1];
  v_rep_b := array(select x from unnest(v_blue) x where x <> v_det_b);
  v_rep_r := array(select x from unnest(v_red)  x where x <> v_det_r);

  -- Casus: her takımda >=2 raporcu (teamSize>=3) varsa raporculardan 1.
  if v_mole_enabled and coalesce(array_length(v_rep_b, 1), 0) >= 2 then
    v_mole_b := v_rep_b[1 + floor(random() * array_length(v_rep_b, 1))::int];
  end if;
  if v_mole_enabled and coalesce(array_length(v_rep_r, 1), 0) >= 2 then
    v_mole_r := v_rep_r[1 + floor(random() * array_length(v_rep_r, 1))::int];
  end if;

  -- Kategori havuzu (geri-uyum: assignments hâlâ "kim raporcu" anahtar setidir).
  v_pref_cats := array(
    select c from (
      select distinct jsonb_array_elements_text(coalesce(v_scene->'cats', '[]'::jsonb)) as c
    ) s
    where s.c in ('geography', 'architecture', 'people', 'period')
    order by random());
  v_rest_cats := array(
    select c from unnest(array['geography', 'architecture', 'people', 'period']) c
    where not (c = any(coalesce(v_pref_cats, array[]::text[])))
    order by random());
  v_cats := coalesce(v_pref_cats, array[]::text[]) || coalesce(v_rest_cats, array[]::text[]);

  v_all_reporters := coalesce(v_rep_b, array[]::text[]) || coalesce(v_rep_r, array[]::text[]);
  v_all_reporters := array(select x from unnest(v_all_reporters) x order by random());
  v_n := coalesce(array_length(v_all_reporters, 1), 0);
  for i in 1..v_n loop
    v_assignments := v_assignments || jsonb_build_object(
      v_all_reporters[i], v_cats[((i - 1) % 4) + 1]);
  end loop;

  -- Routing: dürüst raporcular kendi dedektifine; casus karşı dedektife.
  v_honest_b := array(select x from unnest(v_rep_b) x where v_mole_b is null or x <> v_mole_b);
  v_honest_r := array(select x from unnest(v_rep_r) x where v_mole_r is null or x <> v_mole_r);

  v_order_b := coalesce(v_honest_b, array[]::text[]);
  if v_mole_r is not null then v_order_b := v_order_b || v_mole_r; end if;
  v_order_b := array(select x from unnest(v_order_b) x order by random());

  v_order_r := coalesce(v_honest_r, array[]::text[]);
  if v_mole_b is not null then v_order_r := v_order_r || v_mole_b; end if;
  v_order_r := array(select x from unnest(v_order_r) x order by random());

  -- Aday seti: her kategoriden 3 soru → 12 → karıştır (tur boyu sabit, persisted).
  foreach v_qcat in array array['alphabet', 'traffic', 'architecture', 'nature'] loop
    v_qpick := array(
      select q from (
        select jsonb_array_elements_text(coalesce(v_qpool->v_qcat, '[]'::jsonb)) as q
      ) s
      order by random()
      limit 3
    );
    if coalesce(array_length(v_qpick, 1), 0) > 0 then
      v_cands := v_cands || to_jsonb(v_qpick);
    end if;
  end loop;
  v_cands := coalesce((
    select jsonb_agg(elem order by random())
      from jsonb_array_elements(v_cands) elem
  ), '[]'::jsonb);

  return jsonb_build_object(
    'sceneId',           v_scene->>'id',
    'detectives',        jsonb_build_object('blue', v_det_b, 'red', v_det_r),
    'moles',             jsonb_build_object('blue', to_jsonb(v_mole_b), 'red', to_jsonb(v_mole_r)),
    'assignments',       v_assignments,
    'reportOrder',       jsonb_build_object('blue', to_jsonb(v_order_b), 'red', to_jsonb(v_order_r)),
    'questionCandidates', v_cands,
    'selectedQuestions', jsonb_build_object('blue', '[]'::jsonb, 'red', '[]'::jsonb),
    'answers',           '{}'::jsonb,
    'reports',           '{}'::jsonb,
    'guesses',           jsonb_build_object('blue', 'null'::jsonb, 'red', 'null'::jsonb),
    'results',           'null'::jsonb
  );
end;
$$;

revoke all on function public.tevatur_kn_build_round(jsonb, int) from public;
grant execute on function public.tevatur_kn_build_round(jsonb, int) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_kn_fill_questions — eksik seçimi turun ADAY setinden 5'e tamamlar
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


-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_kn_select_questions — dedektif seçimi; turun ADAY setine göre doğrular
-- ----------------------------------------------------------------------------
-- Tek fark: havuz dışı id ataması yerine round.questionCandidates dışındaki id'ler
-- elenir. Dedektif yalnız o turun 12 adayını gördüğü için pratikte hepsi geçerlidir;
-- yine de server-otoriter doğrulama tek doğru kaynağı garantiler.
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
-- 4) tevatur_kn_start_game — v3 (questionPool artık kategori→id[] sözlüğü)
-- ----------------------------------------------------------------------------
-- İmza DEĞİŞMEDİ (uuid,uuid,uuid,jsonb,jsonb). p_question_pool artık string[] değil,
-- {"alphabet":[...],"traffic":[...],"architecture":[...],"nature":[...]} sözlüğü;
-- her kategoride en az KN_QUESTION_PER_CATEGORY(3) id olmalı. state.questionPool'a
-- temizlenmiş hâliyle yazılır; build_round tur başına buradan aday üretir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_scenes         jsonb,
  p_question_pool  jsonb
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.tevatur_rooms;
  v_blue      text[];
  v_red       text[];
  v_nblue     int;
  v_nred      int;
  v_mole      boolean;
  v_totals    jsonb := jsonb_build_object('blue', 0, 'red', 0);
  v_scenes    jsonb := '[]'::jsonb;
  v_qpool     jsonb := '{}'::jsonb;
  v_qcat      text;
  v_catarr    jsonb;
  v_el        jsonb;
  v_banned    jsonb;
  v_cats      jsonb;
  v_state     jsonb;
  i           int;
begin
  if not public.tevatur_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  v_blue := array(
    select id::text from public.tevatur_players
     where room_id = p_room_id and team = 'blue' order by joined_at asc);
  v_red := array(
    select id::text from public.tevatur_players
     where room_id = p_room_id and team = 'red' order by joined_at asc);
  v_nblue := coalesce(array_length(v_blue, 1), 0);
  v_nred  := coalesce(array_length(v_red, 1), 0);

  -- Eşit takım + 2v2/3v3/4v4/5v5; tek/eşitsiz/atanmamış oyuncu → hata.
  if v_nblue <> v_nred or v_nblue < 2 or v_nblue > 5
     or (v_nblue + v_nred) <> (select count(*) from public.tevatur_players where room_id = p_room_id) then
    raise exception 'player_count_invalid' using errcode = 'P0001';
  end if;

  -- Casus yalnız 3v3+ etkin (2v2'de raporcu 1, casus anlamsız).
  v_mole := coalesce(v_room.mole_enabled, true) and v_nblue >= 3;

  -- Sahne planı sanitizasyonu (v2 ile aynı).
  if p_scenes is null
     or jsonb_typeof(p_scenes) <> 'array'
     or jsonb_array_length(p_scenes) <> v_room.round_count then
    raise exception 'scenes_invalid' using errcode = '22023';
  end if;

  for i in 0..(jsonb_array_length(p_scenes) - 1) loop
    v_el := p_scenes->i;
    if jsonb_typeof(v_el) <> 'object'
       or coalesce(length(v_el->>'id'), 0) not between 1 and 80
       or jsonb_typeof(v_el->'lat') <> 'number'
       or jsonb_typeof(v_el->'lng') <> 'number'
       or (v_el->>'lat')::double precision not between -90 and 90
       or (v_el->>'lng')::double precision not between -180 and 180 then
      raise exception 'scenes_invalid' using errcode = '22023';
    end if;

    v_banned := coalesce(v_el->'banned', '[]'::jsonb);
    if jsonb_typeof(v_banned) <> 'array' or jsonb_array_length(v_banned) > 80 then
      raise exception 'scenes_invalid' using errcode = '22023';
    end if;
    v_banned := coalesce((
      select jsonb_agg(to_jsonb(left(w, 60)))
        from (select jsonb_array_elements_text(v_banned) as w) s
       where length(btrim(w)) > 0
    ), '[]'::jsonb);

    v_cats := coalesce((
      select jsonb_agg(distinct to_jsonb(c))
        from (select jsonb_array_elements_text(coalesce(v_el->'cats', '[]'::jsonb)) as c) s
       where c in ('geography', 'architecture', 'people', 'period')
    ), '[]'::jsonb);

    v_scenes := v_scenes || jsonb_build_array(jsonb_build_object(
      'id',     v_el->>'id',
      'lat',    (v_el->>'lat')::double precision,
      'lng',    (v_el->>'lng')::double precision,
      'banned', v_banned,
      'cats',   v_cats
    ));
  end loop;

  -- Soru havuzu sanitizasyonu: kategori→id[] sözlüğü; her kategoride en az 3 id.
  if p_question_pool is null or jsonb_typeof(p_question_pool) <> 'object' then
    raise exception 'question_pool_invalid' using errcode = '22023';
  end if;
  foreach v_qcat in array array['alphabet', 'traffic', 'architecture', 'nature'] loop
    v_catarr := coalesce((
      select jsonb_agg(distinct to_jsonb(q))
        from (select jsonb_array_elements_text(
               coalesce(p_question_pool->v_qcat, '[]'::jsonb)) as q) s
       where length(btrim(q)) between 1 and 80
    ), '[]'::jsonb);
    if jsonb_array_length(v_catarr) < 3 then
      raise exception 'question_pool_invalid' using errcode = '22023';
    end if;
    v_qpool := v_qpool || jsonb_build_object(v_qcat, v_catarr);
  end loop;

  v_state := jsonb_build_object(
    'version',        3,
    'roundCount',     v_room.round_count,
    'moleEnabled',    v_mole,
    'teams',          jsonb_build_object('blue', to_jsonb(v_blue), 'red', to_jsonb(v_red)),
    'detectiveOrder', jsonb_build_object('blue', to_jsonb(v_blue), 'red', to_jsonb(v_red)),
    'scenes',         v_scenes,
    'questionPool',   v_qpool,
    'totals',         v_totals,
    'roundIndex',     0,
    'phase',          'role_reveal',
    'phaseEndsAt',    public.tevatur_kn_now_ms() + 4000,
    'rounds',         '[]'::jsonb
  );
  v_state := jsonb_set(
    v_state, '{rounds}',
    jsonb_build_array(public.tevatur_kn_build_round(v_state, 0))
  );

  update public.tevatur_rooms
     set status     = 'playing',
         started_at = now(),
         game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_start_game(uuid, uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.tevatur_kn_start_game(uuid, uuid, uuid, jsonb, jsonb) to authenticated;


-- ============================================================================
-- DONE — round.questionCandidates server-otoriter tek doğru kaynak. Client
-- (korNoktaQuestions kategorili havuz + korNoktaGameTypes questionCandidates +
-- KorNoktaGame grid) ile BİRLİKTE deploy edilmeli.
-- ============================================================================
</content>
