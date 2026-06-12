-- ============================================================================
-- Kör Nokta — Gameplay V1 (dedektif / raporcu / köstebek tur döngüsü)
-- ============================================================================
-- Mevcut tevatur_* iskeletinin üzerine kurulur; tablo/RPC YENİDEN ADLANDIRILMAZ.
-- Bu migration:
--   • tevatur_rooms.game_state jsonb kolonu ekler (lobi fazında NULL).
--   • Yardımcılar: tevatur_kn_now_ms / normalize_text / text_has_banned /
--     distance_km / build_round / compute_result
--   • RPC'ler: tevatur_kn_start_game / submit_report / submit_guess /
--     advance_phase (hepsi SECURITY DEFINER, yalnız authenticated)
--
-- Senkronizasyon modeli:
--   • Tüm oyun durumu tek jsonb blob'da (game_state) yaşar; her yazma
--     mevcut tevatur_rooms UPDATE realtime aboneliğiyle tüm oyunculara akar
--     (replica identity full). Yeni kanal/publication üyeliği GEREKMEZ.
--   • Faz ilerletme host-authoritative'dir (Conquest/WheelGroup pattern'i):
--     host client phaseEndsAt geçince advance_phase çağırır; raporların
--     tamamı gelince veya dedektif tahmin gönderince server kendisi ilerletir.
--   • phaseEndsAt epoch ms olarak yazılır; client serverClock offset'iyle
--     karşılaştırır.
--
-- MVP gizlilik notu (spec §10): moleId / rapor sahipleri / sahne id'si blob
-- içinde tüm client'lara gider; UI rol bazlı gizler. Sahne koordinatları
-- zaten client bundle'ında (korNoktaScenes.ts) mevcut olduğundan ayrı bir
-- secrets tablosu ek koruma sağlamazdı.
--
-- game_state şekli (version 1):
-- {
--   "version": 1,
--   "roundCount": 7,
--   "playerOrder": ["<player_id>", ...],          -- joined_at sırası, başta sabitlenir
--   "scenes": [{"id","lat","lng","banned":[],"cats":[]}, ...],  -- uzunluk = roundCount
--   "totals": {"<player_id>": 0, ...},
--   "roundIndex": 0,
--   "phase": "role_reveal" | "observe_report" | "detective_guess"
--          | "round_reveal" | "final_results",
--   "phaseEndsAt": 1760000000000 | null,           -- epoch ms
--   "rounds": [{
--     "sceneId": "kn_003",
--     "detectiveId": "<player_id>",
--     "moleId": "<player_id>" | null,
--     "assignments": {"<player_id>": "geography", ...},
--     "reportOrder": ["<player_id>", ...],          -- anonim A/B/C/D sırası
--     "reports": {"<player_id>": {"text": "...", "at": <ms>}},
--     "guess": {"lat","lng","suspect": "<player_id>"|"none","useful": "<player_id>"|null} | null,
--     "result": {"distanceKm","mapScore","caught","scores":{...}} | null
--   }]
-- }
--
-- İdempotent: add column if not exists + create or replace function.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Kolon
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_rooms
  add column if not exists game_state jsonb null;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Yardımcılar
-- ────────────────────────────────────────────────────────────────────────────

-- Server epoch ms — phaseEndsAt için tek zaman kaynağı.
create or replace function public.tevatur_kn_now_ms()
returns bigint
language sql
stable
as $$
  select (floor(extract(epoch from clock_timestamp()) * 1000))::bigint;
$$;

revoke all on function public.tevatur_kn_now_ms() from public;
grant execute on function public.tevatur_kn_now_ms() to authenticated;


-- Rapor metni normalizasyonu (client'taki normalizeReportText ile aynı kural):
-- lowercase + Türkçe karakter sadeleştirme + sembol → boşluk + boşluk sıkıştır.
create or replace function public.tevatur_kn_normalize_text(p_input text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(lower(coalesce(p_input, '')), 'ıİğüşöçâîû', 'iigusocaiu'),
        '[^a-z0-9 ]', ' ', 'g'
      ),
      ' +', ' ', 'g'
    )
  );
$$;

revoke all on function public.tevatur_kn_normalize_text(text) from public;
grant execute on function public.tevatur_kn_normalize_text(text) to authenticated;


-- Yasaklı kelime kontrolü. Düz string match DEĞİL:
--   • 4+ karakterli yasaklılar compact (boşluksuz) metinde substring aranır
--     → "t ü r k i y e", "tur-kiye" gibi kaçaklar yakalanır.
--   • 2–3 karakterli kısa yasaklılar ("tr" gibi) token eşitliği veya compact
--     tam eşitlikle yakalanır → "tras" gibi false-positive olmaz. Tek-harf
--     dizileri birleştirilerek ("t r", "t-r" → "tr") token listesine eklenir.
create or replace function public.tevatur_kn_text_has_banned(
  p_text   text,
  p_banned jsonb
) returns boolean
language plpgsql
immutable
as $$
declare
  v_norm     text := public.tevatur_kn_normalize_text(p_text);
  v_compact  text;
  v_merged   text;
  v_prev     text;
  v_tokens   text[];
  v_word     text;
  v_cword    text;
begin
  if p_banned is null or jsonb_typeof(p_banned) <> 'array' then
    return false;
  end if;
  if length(v_norm) = 0 then
    return false;
  end if;

  v_compact := replace(v_norm, ' ', '');

  -- Ardışık tek-harf token'larını birleştir: "t r sinirinda" → "tr sinirinda".
  v_merged := v_norm;
  loop
    v_prev   := v_merged;
    v_merged := regexp_replace(v_merged, '\m([a-z0-9]) ([a-z0-9])\M', '\1\2', 'g');
    exit when v_merged = v_prev;
  end loop;

  v_tokens := string_to_array(v_norm, ' ') || string_to_array(v_merged, ' ');

  for v_word in select jsonb_array_elements_text(p_banned) loop
    v_cword := replace(public.tevatur_kn_normalize_text(v_word), ' ', '');
    if length(v_cword) = 0 then
      continue;
    end if;
    if length(v_cword) >= 4 then
      if position(v_cword in v_compact) > 0 then
        return true;
      end if;
    else
      if v_compact = v_cword or v_cword = any(v_tokens) then
        return true;
      end if;
    end if;
  end loop;

  return false;
end;
$$;

revoke all on function public.tevatur_kn_text_has_banned(text, jsonb) from public;
grant execute on function public.tevatur_kn_text_has_banned(text, jsonb) to authenticated;


-- Haversine (km) — client'taki geoUtils.calculateDistanceKm ile aynı model.
create or replace function public.tevatur_kn_distance_km(
  p_lat1 double precision,
  p_lng1 double precision,
  p_lat2 double precision,
  p_lng2 double precision
) returns double precision
language sql
immutable
as $$
  select 6371.0 * 2 * asin(least(1.0, sqrt(
    pow(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2))
      * pow(sin(radians(p_lng2 - p_lng1) / 2), 2)
  )));
$$;

revoke all on function public.tevatur_kn_distance_km(double precision, double precision, double precision, double precision) from public;
grant execute on function public.tevatur_kn_distance_km(double precision, double precision, double precision, double precision) to authenticated;


-- Yeni tur objesi üretir. Kurallar:
--   • Dedektif playerOrder üzerinden sırayla döner (roundIndex mod N).
--   • Köstebek 1. turda (index 0) YOK; sonraki turlarda %60 ihtimalle
--     raporculardan rastgele 1 kişi. Dedektif asla köstebek olamaz.
--   • Kategoriler: önce sahnenin uygun kategorileri (cats, karıştırılmış),
--     yetmezse havuzun kalanı; her raporcuya benzersiz kategori.
--   • reportOrder: anonim Rapor A/B/C/D etiketleri için karıştırılmış sıra.
create or replace function public.tevatur_kn_build_round(
  p_state       jsonb,
  p_round_index int
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_player_order text[];
  v_detective    text;
  v_reporters    text[];
  v_shuffled     text[];
  v_report_order text[];
  v_mole         text  := null;
  v_scene        jsonb;
  v_pref_cats    text[];
  v_rest_cats    text[];
  v_cats         text[];
  v_assignments  jsonb := '{}'::jsonb;
  v_n            int;
  i              int;
begin
  v_player_order := array(select jsonb_array_elements_text(p_state->'playerOrder'));
  v_scene        := p_state->'scenes'->p_round_index;
  v_detective    := v_player_order[(p_round_index % array_length(v_player_order, 1)) + 1];
  v_reporters    := array(select x from unnest(v_player_order) x where x <> v_detective);
  v_n            := array_length(v_reporters, 1);

  -- Köstebek: ısınma turu (index 0) hariç %60 ihtimal.
  if p_round_index >= 1 and random() < 0.60 then
    v_mole := v_reporters[1 + floor(random() * v_n)::int];
  end if;

  -- Kategori sırası: sahne tercihi önce, kalan havuz sonra (ikisi de shuffle).
  v_pref_cats := array(
    select c from (
      select distinct jsonb_array_elements_text(coalesce(v_scene->'cats', '[]'::jsonb)) as c
    ) s
    where s.c in ('geography', 'architecture', 'people', 'period')
    order by random()
  );
  v_rest_cats := array(
    select c from unnest(array['geography', 'architecture', 'people', 'period']) c
    where not (c = any(coalesce(v_pref_cats, array[]::text[])))
    order by random()
  );
  v_cats := coalesce(v_pref_cats, array[]::text[]) || coalesce(v_rest_cats, array[]::text[]);

  v_shuffled := array(select x from unnest(v_reporters) x order by random());
  for i in 1..v_n loop
    v_assignments := v_assignments || jsonb_build_object(v_shuffled[i], v_cats[i]);
  end loop;

  v_report_order := array(select x from unnest(v_reporters) x order by random());

  return jsonb_build_object(
    'sceneId',     v_scene->>'id',
    'detectiveId', v_detective,
    'moleId',      v_mole,
    'assignments', v_assignments,
    'reportOrder', to_jsonb(v_report_order),
    'reports',     '{}'::jsonb,
    'guess',       null,
    'result',      null
  );
end;
$$;

revoke all on function public.tevatur_kn_build_round(jsonb, int) from public;
grant execute on function public.tevatur_kn_build_round(jsonb, int) to authenticated;


-- Tur sonucunu hesaplar (puanlama V1, spec §9):
--   • Harita skoru: 5000 * exp(-km/2000), 0–5000.
--   • Dedektif: harita skoru; köstebek doğru bilinirse / yokken "yoktu"
--     denirse +500.
--   • Dürüst raporcu: rapor GÖNDERDİYSE harita skorunun %50'si; "en faydalı"
--     seçildiyse +300.
--   • Köstebek: dedektif <1500 ve yakalanmadıysa +3000 (+500 "en faydalı"
--     seçilme kandırma bonusu); aksi halde 0.
--   • p_guess NULL ise (süre doldu, tahmin yok): mapScore 0 kabul edilir.
create or replace function public.tevatur_kn_compute_result(
  p_scene jsonb,
  p_round jsonb,
  p_guess jsonb
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_detective text  := p_round->>'detectiveId';
  v_mole      text  := p_round->>'moleId';
  v_reports   jsonb := coalesce(p_round->'reports', '{}'::jsonb);
  v_suspect   text  := null;
  v_useful    text  := null;
  v_dist      double precision := null;
  v_map       int   := 0;
  v_caught    boolean;
  v_scores    jsonb := '{}'::jsonb;
  v_det_pts   int;
  v_pts       int;
  r           text;
begin
  if p_guess is not null and jsonb_typeof(p_guess) = 'object' then
    v_dist := public.tevatur_kn_distance_km(
      (p_scene->>'lat')::double precision,
      (p_scene->>'lng')::double precision,
      (p_guess->>'lat')::double precision,
      (p_guess->>'lng')::double precision
    );
    v_map     := greatest(0, round(5000 * exp(-v_dist / 2000.0)))::int;
    v_suspect := p_guess->>'suspect';
    v_useful  := p_guess->>'useful';
  end if;

  v_caught := (v_mole is not null and v_suspect is not null and v_suspect = v_mole);

  v_det_pts := v_map;
  if v_mole is not null and v_caught then
    v_det_pts := v_det_pts + 500;
  elsif v_mole is null and v_suspect = 'none' then
    v_det_pts := v_det_pts + 500;
  end if;
  v_scores := v_scores || jsonb_build_object(v_detective, v_det_pts);

  for r in select jsonb_object_keys(coalesce(p_round->'assignments', '{}'::jsonb)) loop
    if v_mole is not null and r = v_mole then
      v_pts := case when v_map < 1500 and not v_caught then 3000 else 0 end;
      if v_map < 1500 and not v_caught and v_useful is not null and v_useful = r then
        v_pts := v_pts + 500;  -- kandırma bonusu
      end if;
    else
      v_pts := case when v_reports ? r then floor(v_map * 0.5)::int else 0 end;
      if v_useful is not null and v_useful = r and (v_reports ? r) then
        v_pts := v_pts + 300;
      end if;
    end if;
    v_scores := v_scores || jsonb_build_object(r, v_pts);
  end loop;

  return jsonb_build_object(
    'distanceKm', case when v_dist is null then null else round(v_dist::numeric, 1) end,
    'mapScore',   v_map,
    'caught',     v_caught,
    'scores',     v_scores
  );
end;
$$;

revoke all on function public.tevatur_kn_compute_result(jsonb, jsonb, jsonb) from public;
grant execute on function public.tevatur_kn_compute_result(jsonb, jsonb, jsonb) to authenticated;


-- Sonuç + totals + faz geçişini state'e işler (submit_guess ve timeout
-- advance'in ortak kuyruğu).
create or replace function public.tevatur_kn_apply_result(
  p_state jsonb,
  p_guess jsonb
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_idx    int   := (p_state->>'roundIndex')::int;
  v_round  jsonb := p_state->'rounds'->v_idx;
  v_scene  jsonb := p_state->'scenes'->v_idx;
  v_result jsonb;
  v_totals jsonb := p_state->'totals';
  v_key    text;
  v_val    jsonb;
  v_state  jsonb := p_state;
begin
  v_result := public.tevatur_kn_compute_result(v_scene, v_round, p_guess);

  v_round := jsonb_set(v_round, '{guess}',  coalesce(p_guess, 'null'::jsonb));
  v_round := jsonb_set(v_round, '{result}', v_result);

  for v_key, v_val in select * from jsonb_each(v_result->'scores') loop
    v_totals := jsonb_set(
      v_totals,
      array[v_key],
      to_jsonb(coalesce((v_totals->>v_key)::int, 0) + (v_val#>>'{}')::int)
    );
  end loop;

  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);
  v_state := jsonb_set(v_state, '{totals}', v_totals);
  v_state := jsonb_set(v_state, '{phase}', to_jsonb('round_reveal'::text));
  v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 15000));
  return v_state;
end;
$$;

revoke all on function public.tevatur_kn_apply_result(jsonb, jsonb) from public;
grant execute on function public.tevatur_kn_apply_result(jsonb, jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_kn_start_game — host, lobi → gameplay
-- ----------------------------------------------------------------------------
-- p_scenes: host client'ın yerel havuzdan kurduğu plan; uzunluğu round_count
-- olmalı. Her eleman {id, lat, lng, banned[], cats[]}. Server sanitize eder
-- (yalnız bilinen alanlar, tip + aralık kontrolü) ve game_state'e gömer —
-- skor/banned validasyonu server-side bu kopyadan çalışır.
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
  v_room         public.tevatur_rooms;
  v_count        int;
  v_player_order text[];
  v_totals       jsonb := '{}'::jsonb;
  v_scenes       jsonb := '[]'::jsonb;
  v_el           jsonb;
  v_banned       jsonb;
  v_cats         jsonb;
  v_state        jsonb;
  v_pid          text;
  i              int;
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

  select count(*) into v_count
    from public.tevatur_players where room_id = p_room_id;
  if v_count < 3 or v_count > 5 then
    raise exception 'player_count_invalid' using errcode = 'P0001';
  end if;

  -- Sahne planı sanitizasyonu
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

  -- Oyuncu sırası başta sabitlenir; dedektif rotasyonu bunun üzerinden döner.
  v_player_order := array(
    select id::text from public.tevatur_players
     where room_id = p_room_id
     order by joined_at asc
  );
  foreach v_pid in array v_player_order loop
    v_totals := v_totals || jsonb_build_object(v_pid, 0);
  end loop;

  v_state := jsonb_build_object(
    'version',     1,
    'roundCount',  v_room.round_count,
    'playerOrder', to_jsonb(v_player_order),
    'scenes',      v_scenes,
    'totals',      v_totals,
    'roundIndex',  0,
    'phase',       'role_reveal',
    'phaseEndsAt', public.tevatur_kn_now_ms() + 4000,
    'rounds',      '[]'::jsonb
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
-- 4) tevatur_kn_submit_report — raporcu/köstebek, observe_report fazında
-- ----------------------------------------------------------------------------
-- Server-side validasyon (client kontrolüne güvenilmez): 2–5 kelime,
-- 60 karakter tavanı, sahnenin yasaklı kelime listesi (normalize + compact).
-- Tüm raporlar gelince faz otomatik detective_guess'e geçer (60 sn).
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

  -- Tüm raporcular gönderdiyse beklemeden dedektif fazına geç.
  if (select count(*) from jsonb_object_keys(v_round->'assignments'))
     = (select count(*) from jsonb_object_keys(v_round->'reports')) then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 60000));
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
-- 5) tevatur_kn_submit_guess — dedektif, detective_guess fazında
-- ----------------------------------------------------------------------------
-- Pin zorunlu; p_suspect rapor sahibinin player_id'si ya da 'none'
-- ("Köstebek yoktu"). p_useful null olabilir (hiç rapor gelmediyse).
-- Sonuç + puanlar hesaplanır, faz round_reveal'e geçer.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_submit_guess(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_lat         double precision,
  p_lng         double precision,
  p_suspect     text,
  p_useful      text
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

  if v_round->>'detectiveId' <> v_pid then
    raise exception 'not_detective' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_round->'guess') = 'object' then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  -- NaN, Postgres'te tüm sayılardan büyük sıralanır → between kontrolleri
  -- NaN'ı da reddeder. lng için ±100000 tavanı yalnız NaN/Infinity yakalar
  -- (worldCopyJump pan'i meşru olarak ±180'i aşabilir, aşağıda normalize).
  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90
     or p_lng not between -100000 and 100000 then
    raise exception 'guess_required' using errcode = '22023';
  end if;
  -- worldCopyJump pan'i ±180 dışına taşıyabilir → normalize et.
  v_lng := ((p_lng + 180.0) - 360.0 * floor((p_lng + 180.0) / 360.0)) - 180.0;

  if p_suspect is null
     or (p_suspect <> 'none'
         and not (coalesce(v_round->'assignments', '{}'::jsonb) ? p_suspect)) then
    raise exception 'suspect_invalid' using errcode = '22023';
  end if;
  if p_useful is not null
     and not (coalesce(v_round->'assignments', '{}'::jsonb) ? p_useful) then
    raise exception 'useful_invalid' using errcode = '22023';
  end if;

  v_guess := jsonb_build_object(
    'lat',     p_lat,
    'lng',     v_lng,
    'suspect', p_suspect,
    'useful',  p_useful
  );

  v_state := public.tevatur_kn_apply_result(v_state, v_guess);

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision, text, text) from public;
grant execute on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision, text, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) tevatur_kn_advance_phase — host timer / "Sonraki Tur"
-- ----------------------------------------------------------------------------
-- Expected-state guard ile idempotent: host client'ın gönderdiği
-- (round, phase) güncel değilse sessiz no-op (bayat timer çift ateşlese bile
-- state bozulmaz). Geçişler:
--   role_reveal     → observe_report   (30 sn)
--   observe_report  → detective_guess  (60 sn)
--   detective_guess → round_reveal     (tahmin yoksa mapScore=0 sonuç yazılır)
--   round_reveal    → sonraki tur (role_reveal 4 sn) ya da final_results
--                     (son turdan sonra; status='finished')
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
    return v_room;  -- bitmiş/başlamamış oyun → no-op
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
    -- Süre doldu; eksik raporlar "rapor verilmedi" olarak kalır (key yok).
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 60000));

  elsif v_phase = 'detective_guess' then
    -- Dedektif süresinde tahmin göndermedi → tahminsiz sonuç (mapScore 0).
    v_state := public.tevatur_kn_apply_result(v_state, null);

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
-- DONE
-- ============================================================================
-- Doğrulama:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='tevatur_rooms'
--      and column_name='game_state';
--
--   select proname from pg_proc
--    where pronamespace='public'::regnamespace and proname like 'tevatur_kn_%'
--    order by proname;
--   -- Beklenen: advance_phase, apply_result, build_round, compute_result,
--   --           distance_km, normalize_text, now_ms, start_game,
--   --           submit_guess, submit_report, text_has_banned
--
--   select public.tevatur_kn_text_has_banned('t ü r-k i y e',
--          '["turkiye"]'::jsonb);          -- true (compact containment)
--   select public.tevatur_kn_text_has_banned('tras yapan adam',
--          '["tr"]'::jsonb);               -- false (kısa yasaklı substring aramaz)
--   select public.tevatur_kn_text_has_banned('t r sınırında',
--          '["tr"]'::jsonb);               -- true (tek-harf birleştirme → "tr")
-- ============================================================================
