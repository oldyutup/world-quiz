-- ============================================================================
-- Kör Nokta — ana oyun sekanslarının süresi TEK KAYNAKTAN 35 sn
-- ============================================================================
-- Amaç: üç ana oyun sekansının TAMAMI tam 35 saniye olsun ve süre TEK güvenilir
-- kaynaktan gelsin (dağınık magic number YOK):
--
--   1) observe_report   — ortak inceleme + dedektif soru seçimi   → 35 sn
--   2) answer_questions — raporcu/casus seçili soruları cevaplama → 35 sn
--   3) detective_guess  — dedektif harita üzerinde konum tahmini  → 35 sn
--
-- ÖNCE: observe 35 (20260722120000 ile), answer 20, guess 20 idi. answer/guess
-- iki AYRI aktif yolda 20 sn'ye sabitliydi:
--   • tevatur_kn_advance_phase — süre dolunca faz geçişi (observe→answer,
--     answer→guess). Host timer'ı phaseEndsAt'a bakıp bu fonksiyonu çağırır.
--   • tevatur_kn_submit_answer — tüm cevaplayıcılar erken bitirince BEKLEMEDEN
--     detective_guess'e geçen "erken tamamlama" yolu (deadline'ı da o kurardı).
-- Her iki yol da guess'i 20 sn kuruyordu → aynı sekans oyuncuya farklı süre
-- gösterebiliyordu. Artık İKİSİ de ortak kaynağı kullanır.
--
-- TEK KAYNAK: public.tevatur_kn_phase_duration_ms() → 35000 (= 35 sn). Üç ana
-- sekansın phaseEndsAt'ı DAİMA now_ms() + bu fonksiyon ile kurulur; başka yerde
-- 20000/35000 literali kalmaz. role_reveal (4 sn giriş) ve round_reveal (15 sn
-- tur sonucu) ana sekans DEĞİLDİR ve DEĞİŞMEZ.
--
-- Davranış korundu:
--   • Erken tamamlama / bekleme AYNI: submit_answer hâlâ herkes bitince erken
--     geçer; observe_report yine erken geçmez (dedektif erken seçse de 35 sn'yi
--     bekler) — yalnız kurulan deadline artık 35 sn.
--   • Faz geçişi host-authoritative + expected-round/phase guard + FOR UPDATE
--     satır kilidi AYNI (çift ilerleme / bayat çağrı riski değişmedi).
--   • Client deadline'ı yalnız phaseEndsAt'tan türetir → reconnect doğru kalan
--     süreyi görür, host ve diğer oyuncular aynı deadline'ı okur (süre 35'ten
--     yeniden başlamaz). Client'ta süre sabiti YOKTUR; kaynak tek: bu fonksiyon.
--
-- Bu iki fonksiyonun gövdeleri taban sürümlerinin (advance_phase 20260722120000,
-- submit_answer 20260717120000) BİREBİR kopyasıdır; TEK fark üç ana sekansın
-- deadline ifadesinin literal yerine tevatur_kn_phase_duration_ms() kullanmasıdır.
-- build_round / fill_questions / apply_round / select_questions / submit_guess /
-- start_game imzaları ve mantıkları DOKUNULMADI (advance_phase onları ada göre
-- çağırmaya devam eder → en güncel tanımları geçerli kalır).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) TEK KAYNAK: ana oyun sekansı süresi (ms)
-- ----------------------------------------------------------------------------
-- Kör Nokta'daki üç ana sekansın (observe_report / answer_questions /
-- detective_guess) TEK güvenilir süre kaynağı. Değeri değiştirmek için YALNIZ
-- burayı düzenlemek yeterlidir; hiçbir çağıran magic number tutmaz.
--   35000 ms = 35 saniye.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_phase_duration_ms()
returns int
language sql
immutable
as $$
  select 35000;   -- 35 sn — Kör Nokta ana sekans süresi (TEK KAYNAK)
$$;

revoke all on function public.tevatur_kn_phase_duration_ms() from public;
grant execute on function public.tevatur_kn_phase_duration_ms() to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_advance_phase — observe/answer/guess deadline'ı ortak kaynaktan
-- ----------------------------------------------------------------------------
-- 20260722120000 ile BİREBİR aynı; TEK fark: üç ana sekansın phaseEndsAt'ı artık
-- literal (35000/20000/20000) yerine tevatur_kn_phase_duration_ms() (35 sn) ile
-- kurulur. role_reveal (4 sn) ve round_reveal→role_reveal (4 sn) AYNI.
--   role_reveal      → observe_report  (35 sn)  ← ortak kaynak
--   observe_report   → answer_questions(35 sn)  ← ortak kaynak (eski 20)
--   answer_questions → detective_guess (35 sn)  ← ortak kaynak (eski 20)
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
    -- Ortak inceleme + dedektif soru seçimi fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

  elsif v_phase = 'observe_report' then
    -- Süre doldu; dedektif(ler)in eksik seçimi havuzdan 5'e tamamlanır.
    v_state := public.tevatur_kn_fill_questions(v_state);
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('answer_questions'::text));
    -- Cevaplama fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

  elsif v_phase = 'answer_questions' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    -- Konum tahmini fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

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


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_kn_submit_answer — erken tamamlama deadline'ı ortak kaynaktan
-- ----------------------------------------------------------------------------
-- 20260717120000 ile BİREBİR aynı; TEK fark: tüm cevaplayıcılar erken bitince
-- detective_guess'e geçerken kurulan phaseEndsAt artık 20000 literali yerine
-- tevatur_kn_phase_duration_ms() (35 sn) kullanır. Böylece konum tahmini sekansı
-- ister süre dolarak (advance_phase) ister erken tamamlanarak (bu fonksiyon)
-- başlasın DAİMA 35 sn olur. Yetki/faz/soru doğrulaması ve merge mantığı AYNI.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_submit_answer(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_question_id text,
  p_answer      text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_state    jsonb;
  v_idx      int;
  v_round    jsonb;
  v_pid      text := p_player_id::text;
  v_target   text;
  v_existing jsonb;
  v_all_done boolean;
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
  if v_state->>'phase' <> 'answer_questions' then
    raise exception 'wrong_phase' using errcode = 'P0001';
  end if;

  v_idx   := (v_state->>'roundIndex')::int;
  v_round := v_state->'rounds'->v_idx;

  -- Hedef dedektif takımı = cevaplayıcının reportOrder'da yer aldığı takım.
  if (v_round->'reportOrder'->'blue') ? v_pid then
    v_target := 'blue';
  elsif (v_round->'reportOrder'->'red') ? v_pid then
    v_target := 'red';
  else
    raise exception 'not_reporter' using errcode = 'P0001';
  end if;

  -- Soru hedef dedektifin seçtiklerinden olmalı; cevap geçerli olmalı.
  if not (coalesce(v_round->'selectedQuestions'->v_target, '[]'::jsonb) ? p_question_id) then
    raise exception 'question_invalid' using errcode = '22023';
  end if;
  if p_answer not in ('yes', 'no', 'unsure') then
    raise exception 'answer_invalid' using errcode = '22023';
  end if;

  v_existing := coalesce(v_round->'answers'->v_pid, '{}'::jsonb);
  v_existing := v_existing || jsonb_build_object(p_question_id, p_answer);
  v_round    := jsonb_set(v_round, array['answers', v_pid], v_existing, true);
  v_state    := jsonb_set(v_state, array['rounds', v_idx::text], v_round);

  -- Tüm cevaplayıcılar hedef takımlarının seçili sorularını tam cevapladı mı?
  select not exists (
    select 1
      from unnest(array['blue', 'red']) as t(team)
      cross join lateral jsonb_array_elements_text(
        coalesce(v_round->'reportOrder'->t.team, '[]'::jsonb)) as ro(pid)
     where (
       select count(*) from jsonb_array_elements_text(
         coalesce(v_round->'selectedQuestions'->t.team, '[]'::jsonb))
     ) > (
       select count(*) from jsonb_object_keys(
         coalesce(v_round->'answers'->ro.pid, '{}'::jsonb))
     )
  ) into v_all_done;

  if v_all_done then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    -- Erken tamamlama: konum tahmini sekansı yine 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));
  end if;

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_answer(uuid, uuid, uuid, text, text) from public;
grant execute on function public.tevatur_kn_submit_answer(uuid, uuid, uuid, text, text) to authenticated;


-- ============================================================================
-- DONE — üç ana sekans (observe_report / answer_questions / detective_guess) artık
-- TEK KAYNAK tevatur_kn_phase_duration_ms() (35 sn) üzerinden çalışır. answer/guess
-- için 20 sn kuran tüm AKTİF yollar (advance_phase + submit_answer erken tamamlama)
-- 35 sn'ye taşındı. Client ek değişiklik gerektirmez (deadline'ı yalnız phaseEndsAt'
-- tan türetir); bu migration mevcut client ile uyumludur.
-- ============================================================================
