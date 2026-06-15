-- ============================================================================
-- Kör Nokta — Takım tabanlı gameplay (game_state version 2)
-- ============================================================================
-- Mevcut gameplay (V1, tek havuz) RPC'lerini takım moduna dönüştürür. Tüm
-- değişiklikler create-or-replace (imzalar değişmedi); yardımcı fonksiyonlar
-- (now_ms / normalize_text / text_has_banned / distance_km / map_result) ve
-- authorize_* aynen kullanılır.
--
-- Kullanılmayan V1 fonksiyonları (tevatur_kn_submit_judgement, _compute_result,
-- _apply_result) bırakılır — şüpheli/köstebek-yakalama mekaniği takım modunda
-- YOK; client bunları artık çağırmaz.
--
-- game_state şekli (version 2):
-- {
--   "version": 2, "roundCount": 5, "moleEnabled": true,
--   "teams":          {"blue":["<pid>"...], "red":["<pid>"...]},  -- joined_at sırası
--   "detectiveOrder": {"blue":[...], "red":[...]},                -- rotasyon (= teams)
--   "scenes": [{"id","lat","lng","banned":[],"cats":[]}...],
--   "totals": {"blue":0, "red":0},                               -- birikmiş 0–5000
--   "roundIndex": 0,
--   "phase": "role_reveal"|"observe_report"|"detective_guess"
--          | "round_reveal"|"final_results",
--   "phaseEndsAt": 1760000000000 | null,
--   "rounds": [{
--     "sceneId": "kn_003",
--     "detectives": {"blue":"<pid>", "red":"<pid>"},
--     "moles":      {"blue":"<pid>"|null, "red":"<pid>"|null},
--     "assignments":{"<pid>":"geography", ...},                  -- iki takım raporcuları
--     "reportOrder":{"blue":[...], "red":[...]},                 -- her dedektifin GÖRDÜĞÜ
--     "reports":    {"<pid>":{"text","at"}},
--     "guesses":    {"blue":{"lat","lng"}|null, "red":{...}|null},
--     "results":    {"blue":{"distanceKm","score"}, "red":{...}} | null
--   }]
-- }
--
-- Köstebek routing (spec): köstebeğin raporu KARŞI takım dedektifine gider.
--   reportOrder.blue = (mavi dürüst raporcular) + (kırmızı köstebek varsa)
--   reportOrder.red  = (kırmızı dürüst raporcular) + (mavi köstebek varsa)
-- 2v2'de raporcu=1 olduğundan köstebek otomatik çıkmaz (teamSize>=3 şartı).
--
-- Puanlama (spec, GeoGuessr tarzı): her takım dedektifinin tahmini gerçek
-- konuma yakınlığa göre 0–5000 puan (5000·exp(−km/2000), map_result helper'ı);
-- bu turlar boyunca totals'a birikir. Finalde toplamı yüksek takım kazanır.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_build_round — takım rolleri + köstebek routing
-- ----------------------------------------------------------------------------
-- Her takımda dedektif rotasyonla döner (detectiveOrder[team][roundIndex mod n]
-- → ardışık tekrar yok). Köstebek yalnız moleEnabled VE teamSize>=3 ise (her
-- takımda raporculardan 1). Kategoriler sahne tercihli + kalan havuz; raporcu
-- sayısı 4'ü aşarsa havuz döngüsel kullanılır.
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
  v_n            int;
  i              int;
begin
  v_det_b := v_blue_order[(p_round_index % array_length(v_blue_order, 1)) + 1];
  v_det_r := v_red_order[(p_round_index % array_length(v_red_order, 1)) + 1];
  v_rep_b := array(select x from unnest(v_blue) x where x <> v_det_b);
  v_rep_r := array(select x from unnest(v_red)  x where x <> v_det_r);

  -- Köstebek: her takımda >=2 raporcu (teamSize>=3) varsa raporculardan 1.
  if v_mole_enabled and coalesce(array_length(v_rep_b, 1), 0) >= 2 then
    v_mole_b := v_rep_b[1 + floor(random() * array_length(v_rep_b, 1))::int];
  end if;
  if v_mole_enabled and coalesce(array_length(v_rep_r, 1), 0) >= 2 then
    v_mole_r := v_rep_r[1 + floor(random() * array_length(v_rep_r, 1))::int];
  end if;

  -- Kategori havuzu: sahne tercihi önce, kalan sonra (ikisi de shuffle).
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

  -- Tüm raporculara kategori (4'lük havuzu döngüsel kullan; raporcu>4 olabilir).
  v_all_reporters := coalesce(v_rep_b, array[]::text[]) || coalesce(v_rep_r, array[]::text[]);
  v_all_reporters := array(select x from unnest(v_all_reporters) x order by random());
  v_n := coalesce(array_length(v_all_reporters, 1), 0);
  for i in 1..v_n loop
    v_assignments := v_assignments || jsonb_build_object(
      v_all_reporters[i], v_cats[((i - 1) % 4) + 1]);
  end loop;

  -- Routing: dürüst raporcular kendi dedektifine; köstebek karşı dedektife.
  v_honest_b := array(select x from unnest(v_rep_b) x where v_mole_b is null or x <> v_mole_b);
  v_honest_r := array(select x from unnest(v_rep_r) x where v_mole_r is null or x <> v_mole_r);

  v_order_b := coalesce(v_honest_b, array[]::text[]);
  if v_mole_r is not null then v_order_b := v_order_b || v_mole_r; end if;
  v_order_b := array(select x from unnest(v_order_b) x order by random());

  v_order_r := coalesce(v_honest_r, array[]::text[]);
  if v_mole_b is not null then v_order_r := v_order_r || v_mole_b; end if;
  v_order_r := array(select x from unnest(v_order_r) x order by random());

  return jsonb_build_object(
    'sceneId',     v_scene->>'id',
    'detectives',  jsonb_build_object('blue', v_det_b, 'red', v_det_r),
    'moles',       jsonb_build_object('blue', to_jsonb(v_mole_b), 'red', to_jsonb(v_mole_r)),
    'assignments', v_assignments,
    'reportOrder', jsonb_build_object('blue', to_jsonb(v_order_b), 'red', to_jsonb(v_order_r)),
    'reports',     '{}'::jsonb,
    'guesses',     jsonb_build_object('blue', 'null'::jsonb, 'red', 'null'::jsonb),
    'results',     'null'::jsonb
  );
end;
$$;

revoke all on function public.tevatur_kn_build_round(jsonb, int) from public;
grant execute on function public.tevatur_kn_build_round(jsonb, int) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_kn_apply_round — iki takımın mesafe skorunu hesaplar + totals
-- ----------------------------------------------------------------------------
-- Her takımın guesses[team]'ine göre {distanceKm, score} (score = map skoru,
-- tahmin yoksa 0). totals'a eklenir, faz round_reveal'e geçer (15 sn).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_apply_round(
  p_state jsonb
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_idx     int   := (p_state->>'roundIndex')::int;
  v_round   jsonb := p_state->'rounds'->v_idx;
  v_scene   jsonb := p_state->'scenes'->v_idx;
  v_guess_b jsonb := v_round->'guesses'->'blue';
  v_guess_r jsonb := v_round->'guesses'->'red';
  v_mr_b    jsonb;
  v_mr_r    jsonb;
  v_res_b   jsonb;
  v_res_r   jsonb;
  v_totals  jsonb := p_state->'totals';
  v_state   jsonb := p_state;
begin
  v_mr_b := public.tevatur_kn_map_result(
    v_scene, case when jsonb_typeof(v_guess_b) = 'object' then v_guess_b else null end);
  v_mr_r := public.tevatur_kn_map_result(
    v_scene, case when jsonb_typeof(v_guess_r) = 'object' then v_guess_r else null end);

  v_res_b := jsonb_build_object(
    'distanceKm', coalesce(v_mr_b->'distanceKm', 'null'::jsonb),
    'score',      coalesce((v_mr_b->>'mapScore')::int, 0));
  v_res_r := jsonb_build_object(
    'distanceKm', coalesce(v_mr_r->'distanceKm', 'null'::jsonb),
    'score',      coalesce((v_mr_r->>'mapScore')::int, 0));

  v_round := jsonb_set(v_round, '{results}',
    jsonb_build_object('blue', v_res_b, 'red', v_res_r));

  v_totals := jsonb_set(v_totals, '{blue}',
    to_jsonb(coalesce((v_totals->>'blue')::int, 0) + (v_res_b->>'score')::int));
  v_totals := jsonb_set(v_totals, '{red}',
    to_jsonb(coalesce((v_totals->>'red')::int, 0) + (v_res_r->>'score')::int));

  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);
  v_state := jsonb_set(v_state, '{totals}', v_totals);
  v_state := jsonb_set(v_state, '{phase}', to_jsonb('round_reveal'::text));
  v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 15000));
  return v_state;
end;
$$;

revoke all on function public.tevatur_kn_apply_round(jsonb) from public;
grant execute on function public.tevatur_kn_apply_round(jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_kn_start_game — lobi → gameplay (takım modu)
-- ----------------------------------------------------------------------------
-- Oyuncu sayısı 4/6/8/10 VE takımlar eşit olmalı (2v2/3v3/4v4/5v5). teams /
-- detectiveOrder, tevatur_players.team + joined_at'ten kurulur. moleEnabled =
-- room.mole_enabled AND teamSize>=3 (2v2'de köstebek otomatik kapalı).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_scenes         jsonb
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

  -- Köstebek yalnız 3v3+ etkin (2v2'de raporcu 1, köstebek anlamsız).
  v_mole := coalesce(v_room.mole_enabled, true) and v_nblue >= 3;

  -- Sahne planı sanitizasyonu (V1 ile aynı).
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
       where length(btrim(s.w)) > 0
    ), '[]'::jsonb);

    v_cats := coalesce((
      select jsonb_agg(distinct to_jsonb(c))
        from (select jsonb_array_elements_text(coalesce(v_el->'cats', '[]'::jsonb)) as c) s
       where s.c in ('geography', 'architecture', 'people', 'period')
    ), '[]'::jsonb);

    v_scenes := v_scenes || jsonb_build_array(jsonb_build_object(
      'id',     v_el->>'id',
      'lat',    (v_el->>'lat')::double precision,
      'lng',    (v_el->>'lng')::double precision,
      'banned', v_banned,
      'cats',   v_cats
    ));
  end loop;

  v_state := jsonb_build_object(
    'version',        2,
    'roundCount',     v_room.round_count,
    'moleEnabled',    v_mole,
    'teams',          jsonb_build_object('blue', to_jsonb(v_blue), 'red', to_jsonb(v_red)),
    'detectiveOrder', jsonb_build_object('blue', to_jsonb(v_blue), 'red', to_jsonb(v_red)),
    'scenes',         v_scenes,
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

revoke all on function public.tevatur_kn_start_game(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.tevatur_kn_start_game(uuid, uuid, uuid, jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) tevatur_kn_submit_report — raporcu/köstebek (iki takım), observe_report
-- ----------------------------------------------------------------------------
-- V1 ile aynı validasyon; tüm atanmış raporcular (iki takım) gönderince
-- detective_guess'e geçilir (20 sn).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_submit_report(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_text        text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room    public.tevatur_rooms;
  v_state   jsonb;
  v_idx     int;
  v_round   jsonb;
  v_scene   jsonb;
  v_pid     text := p_player_id::text;
  v_text    text;
  v_words   int;
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
  v_scene := v_state->'scenes'->v_idx;

  if not (coalesce(v_round->'assignments', '{}'::jsonb) ? v_pid) then
    raise exception 'not_reporter' using errcode = 'P0001';
  end if;
  if coalesce(v_round->'reports', '{}'::jsonb) ? v_pid then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  v_text := btrim(coalesce(p_text, ''));
  if length(v_text) = 0 then
    raise exception 'report_word_count' using errcode = '22023';
  end if;
  if length(v_text) > 60 then
    raise exception 'report_too_long' using errcode = '22023';
  end if;

  v_words := coalesce(array_length(
    string_to_array(public.tevatur_kn_normalize_text(v_text), ' '), 1), 0);
  if v_words < 2 or v_words > 5 then
    raise exception 'report_word_count' using errcode = '22023';
  end if;

  if public.tevatur_kn_text_has_banned(v_text, v_scene->'banned') then
    raise exception 'report_banned' using errcode = '22023';
  end if;

  v_round := jsonb_set(
    coalesce(v_round, '{}'::jsonb),
    array['reports', v_pid],
    jsonb_build_object('text', v_text, 'at', public.tevatur_kn_now_ms())
  );
  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);

  -- İki takımın tüm raporcuları gönderdiyse beklemeden dedektif fazına geç.
  if (select count(*) from jsonb_object_keys(v_round->'assignments'))
     = (select count(*) from jsonb_object_keys(v_round->'reports')) then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 20000));
  end if;

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_report(uuid, uuid, uuid, text) from public;
grant execute on function public.tevatur_kn_submit_report(uuid, uuid, uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) tevatur_kn_submit_guess — dedektif (kendi takımı), detective_guess
-- ----------------------------------------------------------------------------
-- Çağıranın hangi takımın dedektifi olduğu bulunur; guesses[team] yazılır.
-- İki takımın da tahmini gelince ortak sonuç hesaplanır (apply_round) →
-- round_reveal. Şüpheli/köstebek-yakalama YOK.
-- ────────────────────────────────────────────────────────────────────────────

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

  -- İki dedektif de tahmin gönderdiyse ortak sonucu hesapla → round_reveal.
  if jsonb_typeof(v_round->'guesses'->'blue') = 'object'
     and jsonb_typeof(v_round->'guesses'->'red') = 'object' then
    v_state := public.tevatur_kn_apply_round(v_state);
  end if;

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) from public;
grant execute on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) tevatur_kn_advance_phase — takım faz zinciri (host-authoritative)
-- ----------------------------------------------------------------------------
--   role_reveal     → observe_report  (30 sn)
--   observe_report  → detective_guess (20 sn)
--   detective_guess → round_reveal    (apply_round; eksik tahmin = 0 puan)
--   round_reveal    → sonraki tur (role_reveal 4 sn) ya da final_results
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_advance_phase(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_expected_round int,
  p_expected_phase text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.tevatur_rooms;
  v_state jsonb;
  v_idx   int;
  v_phase text;
begin
  if not public.tevatur_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' or v_room.game_state is null then
    return v_room;
  end if;

  v_state := v_room.game_state;
  v_idx   := (v_state->>'roundIndex')::int;
  v_phase := v_state->>'phase';

  -- Bayat çağrı (faz bu arada başka yoldan ilerledi) → no-op.
  if v_idx <> p_expected_round or v_phase <> p_expected_phase then
    return v_room;
  end if;

  if v_phase = 'role_reveal' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('observe_report'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 30000));

  elsif v_phase = 'observe_report' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 20000));

  elsif v_phase = 'detective_guess' then
    -- Süre doldu; eksik tahmin(ler) 0 puan, mevcutlar hesaplanır → round_reveal.
    v_state := public.tevatur_kn_apply_round(v_state);

  elsif v_phase = 'round_reveal' then
    if v_idx + 1 >= (v_state->>'roundCount')::int then
      v_state := jsonb_set(v_state, '{phase}', to_jsonb('final_results'::text));
      v_state := jsonb_set(v_state, '{phaseEndsAt}', 'null'::jsonb);

      update public.tevatur_rooms
         set status          = 'finished',
             finished_at     = now(),
             finished_reason = 'completed',
             game_state      = v_state
       where id = p_room_id
       returning * into v_room;
      return v_room;
    end if;

    v_state := jsonb_set(v_state, '{roundIndex}', to_jsonb(v_idx + 1));
    v_state := jsonb_set(
      v_state, '{rounds}',
      (v_state->'rounds') || jsonb_build_array(
        public.tevatur_kn_build_round(v_state, v_idx + 1)
      )
    );
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('role_reveal'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 4000));

  else
    return v_room;  -- final_results → ilerleyecek faz yok
  end if;

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_advance_phase(uuid, uuid, uuid, int, text) from public;
grant execute on function public.tevatur_kn_advance_phase(uuid, uuid, uuid, int, text) to authenticated;


-- ============================================================================
-- DONE — game_state version 2 (takım modu). Client (korNoktaGameTypes v2 +
-- KorNoktaMode/KorNoktaGame) ile birlikte deploy edilmeli.
-- ============================================================================
