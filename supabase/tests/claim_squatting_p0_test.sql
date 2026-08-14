-- ============================================================================
-- P0 — claim-token squatting / kayıtlı oyuncu kimliğine bürünme REGRESYONU
-- ============================================================================
-- NEREDE KOŞULUR: YALNIZ lokal Supabase (supabase db reset sonrası) veya
-- staging kopyası. CANLIDA KOŞMA. Script tek transaction'dır ve SONUNDA
-- ROLLBACK eder → hiçbir kalıcı iz bırakmaz.
--
-- ÖN KOŞUL:
--   20260814180000_registered_player_claim_auth_hardening.sql uygulanmış olmalı.
--
-- KOŞMA:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f supabase/tests/claim_squatting_p0_test.sql
--   Başarı = hatasız iner ve "TÜM TESTLER GEÇTİ" notice basar.
--
-- NE DOĞRULAR:
--   Yedi `*_authorize_player` helper'ının claim dalı YALNIZ misafire açıktır.
--   Kayıtlı oyuncunun player_id'sine EKİLMİŞ (planted) bir claim satırı olsa
--   bile claim_token yetki VERMEZ; kayıtlı oyuncu yalnız auth.uid() ile
--   yetkilenir. Misafir akışı (profile_id NULL + doğru token) BOZULMAZ.
--
-- NOT: duel_players gibi migration-öncesi (Studio dönemi) tablolarda burada
-- kullanılmayan ek NOT NULL kolon çıkarsa fixture'a eklenmelidir. Test
-- mantığı değişmez.
-- ============================================================================

begin;

do $$
declare
  c_victim   uuid := '00000000-0000-4000-8000-0000000c1a11';  -- kayıtlı kurban
  c_attacker uuid := '00000000-0000-4000-8000-0000000c1a12';  -- saldırgan hesap
  c_planted  uuid := '00000000-0000-4000-8000-0000000c1a13';  -- ekilen token
  c_guesttok uuid := '00000000-0000-4000-8000-0000000c1a14';  -- gerçek misafir token
  c_othertok uuid := '00000000-0000-4000-8000-0000000c1a15';  -- başka misafir token

  m         record;
  v_room    uuid;
  v_victim  uuid;
  v_guest   uuid;
  v_other   uuid;
  v_res     boolean;
  v_fails   int := 0;
  v_checks  int := 0;

  procedure_note text;
begin
  -- duel_rooms tek gerçek oda: room_id NOT NULL olan tablolar için gerekli
  insert into public.duel_rooms (code, status)
  values ('P0TEST', 'playing')
  returning id into v_room;

  for m in
    select * from (values
      ('duel',       'duel_players',        'duel_player_claims',        'duel_authorize_player'),
      ('conquest',   'conquest_players',    'conquest_player_claims',    'conquest_authorize_player'),
      ('wheelDuel',  'wheel_duel_players',  'wheel_duel_player_claims',  'wheel_duel_authorize_player'),
      ('wheelGroup', 'wheel_group_players', 'wheel_group_player_claims', 'wheel_group_authorize_player'),
      ('duelGroup',  'duel_group_players',  'duel_group_player_claims',  'duel_group_authorize_player'),
      ('flagGroup',  'flag_group_players',  'flag_group_player_claims',  'flag_group_authorize_player'),
      ('routeDuel',  'route_duel_players',  'route_duel_player_claims',  'route_duel_authorize_player')
    ) t(mode, ptab, ctab, fn)
  loop
    -- ── fixture ───────────────────────────────────────────────────────────
    -- KURBAN: Hızlı Eşleş şekli → profile_id dolu, claim yuvası BOŞ
    execute format(
      'insert into public.%I (room_id, name, profile_id) values ($1, ''p0-victim'', $2) returning id', m.ptab)
      into v_victim using v_room, c_victim;

    -- MİSAFİR: profile_id NULL + guest_id + kendi token'ı
    execute format(
      'insert into public.%I (room_id, name, guest_id) values ($1, ''p0-guest'', ''p0g1'') returning id', m.ptab)
      into v_guest using v_room;
    execute format('insert into public.%I (player_id, claim_token) values ($1,$2)', m.ctab)
      using v_guest, c_guesttok;

    -- BAŞKA MİSAFİR: farklı token sahibi
    execute format(
      'insert into public.%I (room_id, name, guest_id) values ($1, ''p0-other'', ''p0g2'') returning id', m.ptab)
      into v_other using v_room;
    execute format('insert into public.%I (player_id, claim_token) values ($1,$2)', m.ctab)
      using v_other, c_othertok;

    -- ── SALDIRI: boş claim yuvasını işgal et ──────────────────────────────
    execute format('insert into public.%I (player_id, claim_token) values ($1,$2)', m.ctab)
      using v_victim, c_planted;

    -- ── A) KAYITLI + gerçek oturum → GEÇMELİ ──────────────────────────────
    perform set_config('request.jwt.claim.sub', c_victim::text, true);
    execute format('select public.%I($1, null)', m.fn) into v_res using v_victim;
    v_checks := v_checks + 1;
    if not coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/A]: kayıtlı oyuncu kendi oturumuyla yetkilenemedi', m.mode;
    end if;

    -- ── B) ANON + EKİLMİŞ token → REDDETMELİ ──────────────────────────────
    perform set_config('request.jwt.claim.sub', '', true);
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_victim, c_planted;
    v_checks := v_checks + 1;
    if coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/B]: P0 AÇIK — anon, ekilmiş token ile kayıtlı oyuncu adına yetkilendi', m.mode;
    end if;

    -- ── C) BAŞKA kayıtlı hesap + EKİLMİŞ token → REDDETMELİ ───────────────
    perform set_config('request.jwt.claim.sub', c_attacker::text, true);
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_victim, c_planted;
    v_checks := v_checks + 1;
    if coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/C]: P0 AÇIK — başka hesap ekilmiş token ile kurban adına yetkilendi', m.mode;
    end if;

    -- ── D) MİSAFİR + doğru token → GEÇMELİ (geriye uyumluluk) ─────────────
    perform set_config('request.jwt.claim.sub', '', true);
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_guest, c_guesttok;
    v_checks := v_checks + 1;
    if not coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/D]: MİSAFİR AKIŞI BOZULDU — doğru token reddedildi', m.mode;
    end if;

    -- ── E) MİSAFİR + yanlış token → REDDETMELİ ────────────────────────────
    execute format('select public.%I($1, $2)', m.fn) into v_res
      using v_guest, '00000000-0000-4000-8000-00000000dead'::uuid;
    v_checks := v_checks + 1;
    if coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/E]: yanlış token kabul edildi', m.mode;
    end if;

    -- ── F) MİSAFİR + BAŞKA oyuncunun geçerli token'ı → REDDETMELİ ─────────
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_guest, c_othertok;
    v_checks := v_checks + 1;
    if coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/F]: başka oyuncunun token''ı kabul edildi', m.mode;
    end if;

    -- ── H) DEVREDİLMİŞ misafir (link_guest_player sonrası) ────────────────
    -- profile_id dolar, claim satırı DURUR. Sahibi auth.uid() ile geçmeli,
    -- ama bayat token üçüncü şahsa yetki VERMEMELİ.
    execute format('update public.%I set profile_id = $1, guest_id = null where id = $2', m.ptab)
      using c_victim, v_guest;

    perform set_config('request.jwt.claim.sub', c_victim::text, true);
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_guest, c_guesttok;
    v_checks := v_checks + 1;
    if not coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/H1]: devredilmiş oyuncu kendi oturumuyla yetkilenemedi', m.mode;
    end if;

    perform set_config('request.jwt.claim.sub', '', true);
    execute format('select public.%I($1, $2)', m.fn) into v_res using v_guest, c_guesttok;
    v_checks := v_checks + 1;
    if coalesce(v_res, false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [%/H2]: devirden sonra bayat misafir token''ı hâlâ yetki veriyor', m.mode;
    end if;
  end loop;

  -- ══ BAYRAK DÜELLO: duel_authorize_player''a delegasyon ═════════════════
  perform set_config('request.jwt.claim.sub', '', true);
  select public.flag_duel_authorize_player(
    (select id from public.duel_players where room_id = v_room and profile_id = c_victim limit 1),
    c_planted) into v_res;
  v_checks := v_checks + 1;
  if coalesce(v_res, false) then
    v_fails := v_fails + 1;
    raise warning 'ASSERT FAIL [flagDuel]: delege edilen manuel dal hâlâ ekilmiş token kabul ediyor';
  end if;

  -- ══ KİMLİKSİZ QM SATIRI (profile_id NULL + guest_id NULL) ═════════════
  -- Bayrak QM şekli: claim dalı bu satırı ASLA yetkilendirmemeli; meşru
  -- sahip `flag_duel_queue` köprüsünden geçmeli.
  declare v_qm uuid; begin
    insert into public.duel_players (room_id, name) values (v_room, 'p0-flagqm')
      returning id into v_qm;
    insert into public.duel_player_claims (player_id, claim_token) values (v_qm, c_planted);

    perform set_config('request.jwt.claim.sub', '', true);
    v_checks := v_checks + 1;
    if coalesce(public.flag_duel_authorize_player(v_qm, c_planted), false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [flagDuelQM]: kimliksiz QM satırı planted claim ile ele geçirilebiliyor';
    end if;

    -- meşru QM sahibi: flag_duel_queue köprüsü
    insert into public.flag_duel_queue (profile_id, player_id, player_name,
                                        total_rounds, region, mode_level, max_level_diff)
      values (c_victim, v_qm, 'p0-flagqm', 5, 'world', 1, 0)
      on conflict (profile_id) do update set player_id = excluded.player_id;
    perform set_config('request.jwt.claim.sub', c_victim::text, true);
    v_checks := v_checks + 1;
    if not coalesce(public.flag_duel_authorize_player(v_qm, null), false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [flagDuelQM]: meşru QM sahibi köprüden geçemedi';
    end if;
  end;

  -- ══ ÇARK DÜELLO QM: kimliksiz satır + queue köprüsü ═══════════════════
  declare v_wq uuid; v_wroom uuid := gen_random_uuid(); begin
    insert into public.wheel_duel_players (room_id, name) values (v_wroom, 'p0-wheelqm')
      returning id into v_wq;
    insert into public.wheel_duel_player_claims (player_id, claim_token) values (v_wq, c_planted);

    -- planted claim → RED
    perform set_config('request.jwt.claim.sub', '', true);
    v_checks := v_checks + 1;
    if coalesce(public.wheel_duel_authorize_player(v_wq, c_planted), false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [wheelDuelQM]: kimliksiz QM satırı planted claim ile ele geçirilebiliyor';
    end if;

    -- meşru QM sahibi → GREEN (queue köprüsü)
    insert into public.wheel_duel_queue (profile_id, player_id)
      values (c_victim, v_wq)
      on conflict (profile_id) do update set player_id = excluded.player_id;
    perform set_config('request.jwt.claim.sub', c_victim::text, true);
    v_checks := v_checks + 1;
    if not coalesce(public.wheel_duel_authorize_player(v_wq, null), false) then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [wheelDuelQM]: meşru QM sahibi köprüden geçemedi';
    end if;

    -- kuyruk yazma yetkisi istemciye KAPALI olmalı (köprünün ön koşulu)
    v_checks := v_checks + 1;
    if has_table_privilege('anon', 'public.wheel_duel_queue', 'INSERT')
    or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'INSERT') then
      v_fails := v_fails + 1;
      raise warning 'ASSERT FAIL [wheelDuelQueue]: istemci kuyruğa INSERT edebiliyor — köprü güvenli DEĞİL';
    end if;
  end;

  -- ══ KÖR NOKTA: kanonik model — kontrol grubu ══════════════════════════
  -- tevatur_authorize_player bu migration ile DEĞİŞMEDİ; invaryantı zaten
  -- taşıdığını doğrula (regresyon kalkanı).
  v_checks := v_checks + 1;
  if position('guest_id is not null' in
       (select prosrc from pg_proc
         where oid = to_regprocedure('public.tevatur_authorize_player(uuid,uuid)'))) = 0 then
    v_fails := v_fails + 1;
    raise warning 'ASSERT FAIL [korNokta]: kanonik guard kaybolmuş';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);

  if v_fails > 0 then
    raise exception 'ASSERT FAIL: % / % kontrol başarısız (yukarıdaki warning''lere bak)', v_fails, v_checks;
  end if;

  raise notice 'TÜM TESTLER GEÇTİ — % kontrol, 0 başarısız', v_checks;
end $$;

rollback;
