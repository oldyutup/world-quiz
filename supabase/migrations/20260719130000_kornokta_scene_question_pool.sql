-- ============================================================================
-- Kör Nokta — Sahne türüne göre soru havuzu (per-scene question pool)
-- ============================================================================
-- Sorun: aday seti her tur GLOBAL questionPool'dan (kategori→id[]) üretiliyordu;
-- sahne türü (tarihi/AI vs gerçek-dünya) dikkate alınmıyordu. Böylece tarihi/AI
-- sahnelere "yol çizgisi / araç / plaka / gökdelen" gibi YALNIZ modern gerçek
-- dünyada anlamlı sorular düşebiliyordu.
--
-- Çözüm (minimal, geri-uyumlu): start_game artık her sahne payload'ında OPSİYONEL
-- bir `questionPool` (kategori→id[], sahne türüne göre client'ta filtrelenmiş)
-- kabul eder. build_round aday üretirken ÖNCE sahnenin kendi havuzunu kullanır,
-- yoksa GLOBAL havuza düşer (coalesce). Determinizm AYNI: build_round tur başına
-- bir kez çalışıp round.questionCandidates'ı KALICI yazar → aynı turda refresh/
-- reconnect aynı 12 soru + sıra; yeni turda yeniden üretilir.
--
-- Değişen fonksiyonlar: tevatur_kn_build_round (tek satır: v_qpool kaynağı),
-- tevatur_kn_start_game (sahne döngüsünde opsiyonel per-scene questionPool
-- sanitizasyonu; global p_question_pool sanitizasyonu AYNEN korunur). Casus
-- routing (reportOrder), select_questions, fill_questions, submit_answer,
-- advance/apply, puanlama ve scene seçimi DEĞİŞMEDİ. Client (korNoktaQuestions
-- applicableSourceTypes + buildKnQuestionPoolFor + buildKnScenePlan per-scene
-- pool) ile BİRLİKTE deploy edilmeli.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_build_round — aday seti artık sahnenin kendi havuzundan üretilir
-- ----------------------------------------------------------------------------
-- 20260718120000 ile BİREBİR aynı; TEK fark: v_qpool kaynağı
--   coalesce(v_scene->'questionPool', p_state->'questionPool', '{}').
-- Sahnenin per-scene havuzu varsa o, yoksa global havuz, o da yoksa boş.
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
  -- Per-scene havuz (sahne türüne uygun) öncelikli; yoksa global; o da yoksa boş.
  v_qpool        jsonb   := coalesce(v_scene->'questionPool', p_state->'questionPool', '{}'::jsonb);
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
  -- Kaynak: v_qpool (per-scene havuz öncelikli; sahne türüne uygun id'ler).
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
-- 2) tevatur_kn_start_game — sahne başına opsiyonel questionPool sanitizasyonu
-- ----------------------------------------------------------------------------
-- 20260718120000 ile BİREBİR aynı; TEK ek: sahne döngüsünde v_el->'questionPool'
-- (varsa) sanitize edilir (4 kategori, her biri >=3 id) ve geçerliyse sahne
-- objesine yazılır. Geçersiz/yoksa atlanır → build_round global havuza düşer.
-- Global p_question_pool sanitizasyonu ve diğer her şey AYNEN korunur.
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
  v_room        public.tevatur_rooms;
  v_blue        text[];
  v_red         text[];
  v_nblue       int;
  v_nred        int;
  v_mole        boolean;
  v_totals      jsonb := jsonb_build_object('blue', 0, 'red', 0);
  v_scenes      jsonb := '[]'::jsonb;
  v_qpool       jsonb := '{}'::jsonb;
  v_qcat        text;
  v_catarr      jsonb;
  v_el          jsonb;
  v_banned      jsonb;
  v_cats        jsonb;
  v_scene_obj   jsonb;
  v_scene_qpool jsonb;
  v_pool_ok     boolean;
  v_state       jsonb;
  i             int;
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

  -- Sahne planı sanitizasyonu (v2 ile aynı; + opsiyonel per-scene questionPool).
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

    -- Opsiyonel per-scene soru havuzu (sahne türüne uygun). Geçerliyse sakla;
    -- 4 kategori + her biri >=3 id şartını sağlamazsa atla (global'e düşülür).
    v_scene_qpool := null;
    if jsonb_typeof(v_el->'questionPool') = 'object' then
      v_scene_qpool := '{}'::jsonb;
      v_pool_ok := true;
      foreach v_qcat in array array['alphabet', 'traffic', 'architecture', 'nature'] loop
        v_catarr := coalesce((
          select jsonb_agg(distinct to_jsonb(q))
            from (select jsonb_array_elements_text(
                   coalesce(v_el->'questionPool'->v_qcat, '[]'::jsonb)) as q) s
           where length(btrim(q)) between 1 and 80
        ), '[]'::jsonb);
        if jsonb_array_length(v_catarr) < 3 then v_pool_ok := false; end if;
        v_scene_qpool := v_scene_qpool || jsonb_build_object(v_qcat, v_catarr);
      end loop;
      if not v_pool_ok then v_scene_qpool := null; end if;
    end if;

    v_scene_obj := jsonb_build_object(
      'id',     v_el->>'id',
      'lat',    (v_el->>'lat')::double precision,
      'lng',    (v_el->>'lng')::double precision,
      'banned', v_banned,
      'cats',   v_cats
    );
    if v_scene_qpool is not null then
      v_scene_obj := v_scene_obj || jsonb_build_object('questionPool', v_scene_qpool);
    end if;
    v_scenes := v_scenes || jsonb_build_array(v_scene_obj);
  end loop;

  -- Global soru havuzu sanitizasyonu: kategori→id[] sözlüğü; her kategoride >=3 id.
  -- (build_round fallback'i; per-scene havuz yoksa kullanılır.)
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
-- DONE — build_round artık sahnenin kendi havuzundan aday üretir (yoksa global).
-- Tarihi/AI sahnelere modern-gerçek-dünya soruları DÜŞMEZ. Client ile BİRLİKTE
-- deploy edilmeli (korNoktaQuestions applicableSourceTypes + buildKnScenePlan
-- per-scene questionPool).
-- ============================================================================
