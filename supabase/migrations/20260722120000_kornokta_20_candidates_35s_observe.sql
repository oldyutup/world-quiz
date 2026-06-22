-- ============================================================================
-- Kör Nokta — 20 aday soru + 35 sn ortak inceleme/seçim fazı
-- ============================================================================
-- İki davranış değişikliği (yalnız bu iki fonksiyon):
--
-- 1) Aday soru sayısı 12 → 20 (tevatur_kn_build_round).
--    Eski: her kategoriden TAM 3 → 12. Yeni: her kategoriden EN FAZLA 5 →
--    standart sahnede 5×4 = 20. Bir kategoride 5 uygun soru yoksa (profilli
--    gerçek-dünya sahnesi) o kategorideki TÜM uygun sorular alınır; eksik kalan
--    aday, DİĞER uygun kategorilerin henüz seçilmemiş sorularıyla BENZERSİZCE
--    doldurulur → toplam DAİMA 20, aday listesinde tekrar YOK. Determinizm aynı:
--    build_round tur başına bir kez random çalışır, sonuç round.questionCandidates'a
--    KALICI yazılır (aynı turda refresh/reconnect aynı 20 + sıra).
--
-- 2) Ortak "inceleme + dedektif soru seçimi" fazı (observe_report) 20 → 35 sn
--    (tevatur_kn_advance_phase, role_reveal → observe_report geçişi). Bu TEK ortak
--    fazdır (ayrı raportör/dedektif timer'ı yoktur). Diğer faz süreleri DEĞİŞMEDİ
--    (role 4 / answer 20 / guess 20 / reveal sonrası role 4).
--
-- Dedektifin seçtiği soru sayısı 5 OLARAK KALIR (select_questions ≤5, fill 5'e
-- tamamlar — DOKUNULMADI). Cevaplama, harita tahmini, puanlama, rol rotasyonu,
-- casus routing (reportOrder), kilitleme, erken ilerleme, scene seçimi, 360
-- viewer, native — HİÇBİRİ değişmedi. Client (KN_QUESTION_CANDIDATE_COUNT=20 +
-- seçim ekranı kaydırma/satır sayısı) ile BİRLİKTE deploy edilmeli.
--
-- Taban fonksiyonlar: build_round 20260719130000 (per-scene havuz), advance_phase
-- 20260717120000 (v3 faz zinciri) sürümlerinin BİREBİR kopyasıdır; yalnız yukarıdaki
-- iki nokta değişti. start_game / select_questions / fill_questions / submit_answer /
-- apply_round DOKUNULMADI (imzaları ve mantıkları aynı kalır).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_build_round — 20 aday (kategori başı ≤5 + diğer kategorilerden doldurma)
-- ----------------------------------------------------------------------------
-- 20260719130000 ile BİREBİR aynı; TEK fark: aday seti üretim bloğu (12 → 20)
-- ve iki yeni yerel değişken (v_picked, v_deficit). v_qpool kaynağı, routing,
-- assignments, reportOrder, dönen şekil — HEPSİ AYNI.
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
  v_picked       text[] := array[]::text[];   -- bu turun tüm aday id'leri (dedupe + doldurma için)
  v_deficit      int;                          -- 20'ye ulaşmak için eksik aday sayısı
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

  -- Aday seti (YENİ): her kategoriden EN FAZLA 5 soru → standart sahnede 5×4 = 20.
  -- Bir kategori 5'e ulaşamazsa (profilli sahne, az uygun soru) hepsi alınır;
  -- toplam 20'ye eksik kalırsa DİĞER kategorilerin kalan (seçilmemiş) sorularından
  -- benzersizce doldurulur. Karışık sıra; tur boyu sabit (persisted).
  -- Kaynak: v_qpool (per-scene havuz öncelikli; sahne türüne uygun id'ler).
  foreach v_qcat in array array['alphabet', 'traffic', 'architecture', 'nature'] loop
    v_qpick := array(
      select q from (
        select jsonb_array_elements_text(coalesce(v_qpool->v_qcat, '[]'::jsonb)) as q
      ) s
      order by random()
      limit 5
    );
    if coalesce(array_length(v_qpick, 1), 0) > 0 then
      v_picked := v_picked || v_qpick;
    end if;
  end loop;

  -- Eksik kalan aday sayısını diğer uygun kategorilerin kalan sorularıyla doldur
  -- (benzersiz; tekrar yok). Toplam uygun soru >= 20 olduğundan 20'ye ulaşılır.
  v_deficit := 20 - coalesce(array_length(v_picked, 1), 0);
  if v_deficit > 0 then
    v_qpick := array(
      select s.q from (
        select distinct e.q
          from unnest(array['alphabet', 'traffic', 'architecture', 'nature']) c
          cross join lateral jsonb_array_elements_text(
            coalesce(v_qpool->c, '[]'::jsonb)) as e(q)
      ) s
      where not (s.q = any(v_picked))
      order by random()
      limit v_deficit
    );
    if coalesce(array_length(v_qpick, 1), 0) > 0 then
      v_picked := v_picked || v_qpick;
    end if;
  end if;

  -- Karıştır → kalıcı aday listesi.
  v_cands := coalesce((
    select jsonb_agg(t.q order by random())
      from unnest(v_picked) as t(q)
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
-- 2) tevatur_kn_advance_phase — observe_report fazı 20 → 35 sn
-- ----------------------------------------------------------------------------
-- 20260717120000 ile BİREBİR aynı; TEK fark: role_reveal → observe_report
-- geçişinde phaseEndsAt = now + 35000 (eskiden 20000). Diğer tüm geçişler ve
-- süreler (answer 20 / guess 20 / round_reveal sonrası role 4) AYNI; fill_questions
-- ve apply_round çağrıları AYNI.
--   role_reveal      → observe_report  (35 sn)   ← DEĞİŞEN
--   observe_report   → answer_questions(20 sn) + eksik soru seçimi auto-fill
--   answer_questions → detective_guess (20 sn)
--   detective_guess  → round_reveal    (apply_round; eksik tahmin = 0 puan)
--   round_reveal     → sonraki tur (role_reveal 4 sn) ya da final_results
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
    -- Ortak inceleme + dedektif soru seçimi fazı: 35 sn (tek timer).
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 35000));

  elsif v_phase = 'observe_report' then
    -- Süre doldu; dedektif(ler)in eksik seçimi havuzdan 5'e tamamlanır.
    v_state := public.tevatur_kn_fill_questions(v_state);
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('answer_questions'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 20000));

  elsif v_phase = 'answer_questions' then
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
-- DONE — aday seti artık 20 (5/kategori + diğer kategorilerden benzersiz doldurma),
-- ortak observe_report fazı 35 sn. Dedektif seçimi 5'te kaldı. Client (20 aday
-- sabiti + seçim ekranı kaydırma) ile BİRLİKTE deploy edilmeli.
-- ============================================================================
