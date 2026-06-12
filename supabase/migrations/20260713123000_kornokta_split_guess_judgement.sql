-- ============================================================================
-- Kör Nokta — Dedektif akışını ikiye böl: konum tahmini + rapor değerlendirme
-- ============================================================================
-- 20260713120000_kornokta_gameplay.sql'in (Gameplay V1) ÜZERİNE kurulur.
-- O migration uzak DB'ye uygulanmış olabileceğinden yerinde DEĞİŞTİRİLMEDİ;
-- tüm değişiklikler bu ayrı, idempotent migration'dadır.
--
-- DEPLOY NOTU (ÖNEMLİ): Bu migration client ile BİRLİKTE deploy edilmelidir.
--   • Eski client yeni submit_guess imzasını (suspect/useful'suz) bulamaz →
--     tahmin gönderemez.
--   • Yeni client eski 7 parametreli submit_guess'i ve guess_reveal /
--     report_judgement fazlarını bekler.
--   Yani: önce/eşzamanlı `supabase db push`, sonra/eşzamanlı frontend yayını.
--   İkisi arasında kalan kullanıcılar tahmin fazında hata görebilir.
--
-- Ne değişti:
--   Eski tek-faz dedektif akışı:
--     detective_guess (60 sn) → round_reveal
--     (dedektif aynı ekranda pin + şüpheli + en faydalıyı seçerdi)
--   Yeni dört-faz akış:
--     detective_guess  (20 sn)  — yalnız pin; submit_guess(lat,lng)
--     guess_reveal     (6 sn)   — herkes mesafe + harita skorunu görür
--     report_judgement (15 sn)  — dedektif şüpheli + en faydalıyı seçer;
--                                 submit_judgement(suspect,useful)
--     round_reveal     (15 sn)  — roller + rapor sahipleri açılır
--
-- game_state.rounds[] şekli güncellendi:
--   guess:     {"lat","lng"}                       (eskiden suspect/useful da içerirdi)
--   mapResult: {"distanceKm","mapScore"} | null    (YENİ — guess_reveal'den itibaren)
--   judgement: {"suspect","useful"} | null         (YENİ — report_judgement'tan itibaren)
--   result:    {"distanceKm","mapScore","caught","scores"} | null  (değişmedi)
--
-- İdempotent: drop function if exists + create or replace function.
-- Puanlama kuralları (mapScore curve, +500/+300/+3000 bonusları) DEĞİŞMEDİ.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_map_result — harita kısmi sonucu (mesafe + harita skoru)
-- ----------------------------------------------------------------------------
-- detective_guess kapanırken hesaplanır; guess_reveal ekranı bunu gösterir.
-- p_guess NULL ise (süre doldu, tahmin yok): distanceKm null, mapScore 0.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_map_result(
  p_scene jsonb,
  p_guess jsonb
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_dist double precision := null;
  v_map  int := 0;
begin
  if p_guess is not null and jsonb_typeof(p_guess) = 'object' then
    v_dist := public.tevatur_kn_distance_km(
      (p_scene->>'lat')::double precision,
      (p_scene->>'lng')::double precision,
      (p_guess->>'lat')::double precision,
      (p_guess->>'lng')::double precision
    );
    v_map := greatest(0, round(5000 * exp(-v_dist / 2000.0)))::int;
  end if;
  return jsonb_build_object(
    'distanceKm', case when v_dist is null then null else round(v_dist::numeric, 1) end,
    'mapScore',   v_map
  );
end;
$$;

revoke all on function public.tevatur_kn_map_result(jsonb, jsonb) from public;
grant execute on function public.tevatur_kn_map_result(jsonb, jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_kn_compute_result — tek argümanlı (round içinden okur)
-- ----------------------------------------------------------------------------
-- Eski imza compute_result(scene, round, guess) idi; girdileri artık round'un
-- kendi mapResult + judgement alanlarından okur (faz ayrımıyla bu alanlar
-- ayrı zamanlarda yazılır). Eski 3 argümanlı imza drop edilir.
--   • Dedektif: harita skoru; köstebek doğru bilinirse / yokken "yoktu"
--     denirse +500. judgement yoksa (süre doldu) şüphe bonusu verilmez.
--   • Dürüst raporcu: rapor GÖNDERDİYSE harita skorunun %50'si; "en faydalı"
--     seçildiyse +300 (judgement yoksa bonus yok).
--   • Köstebek: dedektif <1500 ve yakalanmadıysa +3000 (+500 "en faydalı"
--     seçilme kandırma bonusu); aksi halde 0.
-- ────────────────────────────────────────────────────────────────────────────

drop function if exists public.tevatur_kn_compute_result(jsonb, jsonb, jsonb);

create or replace function public.tevatur_kn_compute_result(
  p_round jsonb
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_detective  text  := p_round->>'detectiveId';
  v_mole       text  := p_round->>'moleId';
  v_reports    jsonb := coalesce(p_round->'reports', '{}'::jsonb);
  v_map_result jsonb := p_round->'mapResult';
  v_judgement  jsonb := p_round->'judgement';
  v_suspect    text  := null;
  v_useful     text  := null;
  v_dist       jsonb := 'null'::jsonb;
  v_map        int   := 0;
  v_caught     boolean;
  v_scores     jsonb := '{}'::jsonb;
  v_det_pts    int;
  v_pts        int;
  r            text;
begin
  if v_map_result is not null and jsonb_typeof(v_map_result) = 'object' then
    v_dist := coalesce(v_map_result->'distanceKm', 'null'::jsonb);
    v_map  := coalesce((v_map_result->>'mapScore')::int, 0);
  end if;
  if v_judgement is not null and jsonb_typeof(v_judgement) = 'object' then
    v_suspect := v_judgement->>'suspect';
    v_useful  := v_judgement->>'useful';
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
    'distanceKm', v_dist,
    'mapScore',   v_map,
    'caught',     v_caught,
    'scores',     v_scores
  );
end;
$$;

revoke all on function public.tevatur_kn_compute_result(jsonb) from public;
grant execute on function public.tevatur_kn_compute_result(jsonb) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_kn_apply_result — değerlendirme + sonuç + totals + faz geçişi
-- ----------------------------------------------------------------------------
-- İmza (jsonb, jsonb) aynı kaldı ama 2. argüman artık p_guess değil
-- p_judgement (suspect/useful). round'a judgement yazılır, compute_result
-- tek argümanla çağrılır. p_judgement NULL ise (report_judgement süresi
-- doldu) şüphe/faydalı bonusları verilmez.
--
-- NOT: İmza birebir aynı kaldığından (jsonb, jsonb) ama parametre ADI
-- değiştiğinden (p_guess → p_judgement), CREATE OR REPLACE tek başına
-- "cannot change name of input parameter" (42P13) hatası verir. Önce eski
-- imzayı DROP etmek şart. plpgsql fonksiyon→fonksiyon referansları katalog
-- bağımlılığı oluşturmaz, bu yüzden CASCADE gerekmez; hemen aşağıda yeniden
-- oluşturulduğu için submit_judgement/advance_phase çağrıları da bozulmaz.
-- ────────────────────────────────────────────────────────────────────────────

drop function if exists public.tevatur_kn_apply_result(jsonb, jsonb);

create or replace function public.tevatur_kn_apply_result(
  p_state     jsonb,
  p_judgement jsonb
) returns jsonb
language plpgsql
volatile
as $$
declare
  v_idx    int   := (p_state->>'roundIndex')::int;
  v_round  jsonb := p_state->'rounds'->v_idx;
  v_result jsonb;
  v_totals jsonb := p_state->'totals';
  v_key    text;
  v_val    jsonb;
  v_state  jsonb := p_state;
begin
  v_round  := jsonb_set(v_round, '{judgement}', coalesce(p_judgement, 'null'::jsonb));
  v_result := public.tevatur_kn_compute_result(v_round);

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
-- 4) tevatur_kn_build_round — yeni round'lara mapResult/judgement null ekle
-- ----------------------------------------------------------------------------
-- V1'deki ile aynı; yalnız döndürülen round objesine mapResult/judgement
-- alanları (null) eklenir ki blob şekli baştan tutarlı olsun (client TS
-- kontratı bu alanları bekler). Mantık değişmedi.
-- ────────────────────────────────────────────────────────────────────────────

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
    'mapResult',   null,
    'judgement',   null,
    'result',      null
  );
end;
$$;

revoke all on function public.tevatur_kn_build_round(jsonb, int) from public;
grant execute on function public.tevatur_kn_build_round(jsonb, int) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) tevatur_kn_submit_report — observe → guess timer'ı 60 sn → 20 sn
-- ----------------------------------------------------------------------------
-- V1 ile birebir aynı; yalnız tüm raporlar gelince geçilen detective_guess
-- fazının süresi 60000 → 20000 ms (yeni akışta tahmin daha kısa).
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

  -- Tüm raporcular gönderdiyse beklemeden dedektif fazına geç (20 sn).
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
-- 6) tevatur_kn_submit_guess — yalnız pin (lat/lng); → guess_reveal
-- ----------------------------------------------------------------------------
-- Eski 7 parametreli imza (suspect/useful'lü) DROP edilir; yeni imza sadece
-- konumu alır. mapResult hesaplanır, faz guess_reveal'e geçer (6 sn).
-- Şüpheli/faydalı seçimi artık submit_judgement'ta.
-- ────────────────────────────────────────────────────────────────────────────

drop function if exists public.tevatur_kn_submit_guess(
  uuid, uuid, uuid, double precision, double precision, text, text);

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
  v_scene jsonb;
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
  v_scene := v_state->'scenes'->v_idx;

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

  v_guess := jsonb_build_object('lat', p_lat, 'lng', v_lng);

  v_round := jsonb_set(v_round, '{guess}', v_guess);
  v_round := jsonb_set(v_round, '{mapResult}',
                       public.tevatur_kn_map_result(v_scene, v_guess));
  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);
  v_state := jsonb_set(v_state, '{phase}', to_jsonb('guess_reveal'::text));
  v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 6000));

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
-- 7) tevatur_kn_submit_judgement — dedektif, report_judgement fazında (YENİ)
-- ----------------------------------------------------------------------------
-- p_suspect rapor sahibinin player_id'si ya da 'none' ("Köstebek yoktu");
-- zorunlu. p_useful null olabilir (hiç rapor gelmediyse) ama doluysa gerçek
-- rapor göndermiş birini işaret etmeli. Sonuç + puanlar hesaplanır, faz
-- round_reveal'e geçer.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_submit_judgement(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
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
  if v_state->>'phase' <> 'report_judgement' then
    raise exception 'wrong_phase' using errcode = 'P0001';
  end if;

  v_idx   := (v_state->>'roundIndex')::int;
  v_round := v_state->'rounds'->v_idx;

  if v_round->>'detectiveId' <> v_pid then
    raise exception 'not_detective' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_round->'judgement') = 'object' then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  if p_suspect is null
     or (p_suspect <> 'none'
         and not (coalesce(v_round->'assignments', '{}'::jsonb) ? p_suspect)) then
    raise exception 'suspect_invalid' using errcode = '22023';
  end if;
  if p_useful is not null
     and not (coalesce(v_round->'reports', '{}'::jsonb) ? p_useful) then
    raise exception 'useful_invalid' using errcode = '22023';
  end if;

  v_state := public.tevatur_kn_apply_result(
    v_state,
    jsonb_build_object('suspect', p_suspect, 'useful', p_useful)
  );

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_judgement(uuid, uuid, uuid, text, text) from public;
grant execute on function public.tevatur_kn_submit_judgement(uuid, uuid, uuid, text, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) tevatur_kn_advance_phase — yeni faz zinciri
-- ----------------------------------------------------------------------------
-- Expected-state guard ile idempotent (V1 ile aynı). Geçişler:
--   role_reveal      → observe_report   (30 sn)
--   observe_report   → detective_guess  (20 sn)
--   detective_guess  → guess_reveal     (6 sn; tahmin yoksa mapScore=0
--                      mapResult yazılır, akış yine guess_reveal'den geçer)
--   guess_reveal     → report_judgement (15 sn)
--   report_judgement → round_reveal     (değerlendirme yoksa bonus'suz sonuç)
--   round_reveal     → sonraki tur (role_reveal 4 sn) ya da final_results
--                      (son turdan sonra; status='finished')
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
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 20000));

  elsif v_phase = 'detective_guess' then
    -- Dedektif süresinde tahmin göndermedi → tahminsiz kısmi sonuç
    -- (distanceKm null, mapScore 0); akış yine guess_reveal'den geçer.
    v_state := jsonb_set(
      v_state,
      array['rounds', v_idx::text, 'mapResult'],
      public.tevatur_kn_map_result(v_state->'scenes'->v_idx, null)
    );
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('guess_reveal'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 6000));

  elsif v_phase = 'guess_reveal' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('report_judgement'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 15000));

  elsif v_phase = 'report_judgement' then
    -- Dedektif süresinde değerlendirme göndermedi → bonus'suz sonuç.
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
--   select proname, pg_get_function_identity_arguments(oid)
--     from pg_proc
--    where pronamespace='public'::regnamespace and proname like 'tevatur_kn_%'
--    order by proname;
--   -- submit_guess artık (uuid,uuid,uuid,double precision,double precision);
--   -- submit_judgement (uuid,uuid,uuid,text,text) MEVCUT olmalı;
--   -- compute_result artık tek argümanlı (jsonb); 3-arg sürüm GİTMELİ;
--   -- map_result (jsonb,jsonb) MEVCUT olmalı.
--
--   -- Devam eden oyunlar: ramp boyunca yarıda kalan turlarda yeni round'lar
--   -- mapResult/judgement alanlarını içerir; eski round'larda bu alanlar
--   -- yoktur ama compute_result null'a karşı dayanıklıdır.
-- ============================================================================
