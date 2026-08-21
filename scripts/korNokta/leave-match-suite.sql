-- Kör Nokta leave-match runtime suite. Emits `label|got|want` rows.
-- Yalnız yerel clean-room veritabanında çalışır; production'a DOKUNMAZ.

create temp table res(ord serial, label text, got text, want text);

create or replace function mkroom(p_code text, p_per_team int, p_status text)
returns uuid language plpgsql as $$
declare
  v_room uuid := gen_random_uuid();
  v_id   uuid;
  v_blue jsonb := '[]'::jsonb;
  v_red  jsonb := '[]'::jsonb;
  i int; t text;
begin
  insert into public.tevatur_rooms(id, code, status, host_player_id, game_state)
  values (v_room, p_code, p_status, null, null);

  foreach t in array array['blue','red'] loop
    for i in 1..p_per_team loop
      v_id := gen_random_uuid();
      -- Tek misafir: her takımın 2. oyuncusu misafirdir (anon yolu da kapsansın).
      insert into public.tevatur_players(id, room_id, profile_id, guest_id, name, team, joined_at)
      values (v_id, v_room,
              case when i = 2 then null else v_id end,
              case when i = 2 then 'g-' || v_id::text else null end,
              t || i::text, t, now() + (i || ' seconds')::interval);
      insert into public.tevatur_player_claims(player_id, claim_token) values (v_id, v_id);
      if t = 'blue' then v_blue := v_blue || to_jsonb(v_id::text);
      else                v_red  := v_red  || to_jsonb(v_id::text); end if;
    end loop;
  end loop;

  -- Host = ilk mavi oyuncu (kayıtlı).
  update public.tevatur_rooms set host_player_id = (v_blue->>0)::uuid where id = v_room;

  if p_status <> 'waiting' then
    update public.tevatur_rooms set game_state = jsonb_build_object(
      'version', 3, 'roundCount', 5, 'roundIndex', 0,
      'phase', 'observe_report', 'phaseEndsAt', 9999999999999::bigint,
      'teams',          jsonb_build_object('blue', v_blue, 'red', v_red),
      'detectiveOrder', jsonb_build_object('blue', v_blue, 'red', v_red),
      'totals',         jsonb_build_object('blue', 0, 'red', 0),
      'rounds',         jsonb_build_array(jsonb_build_object('sceneId','kn_001'))
    ) where id = v_room;
  end if;
  return v_room;
end$$;

/* Bir oyuncunun kimliğiyle çıkış çağırır (kayıtlı → uid, misafir → token). */
create or replace function leave_as(p_room uuid, p_player uuid, p_token uuid default null)
returns text language plpgsql as $$
declare v_prof uuid;
begin
  select profile_id into v_prof from public.tevatur_players where id = p_player;
  perform set_config('torble.uid', coalesce(v_prof::text, ''), true);
  perform public.tevatur_kn_leave_match(p_room, p_player, coalesce(p_token, p_player));
  return 'ok';
exception when others then
  return sqlerrm;
end$$;

do $suite$
declare
  r uuid; r2 uuid; p uuid; host uuid; g uuid; n int; s text;
begin
  -- ════════ 1) 2v2 · kayıtlı NON-HOST çıkışı → maç terminal ════════
  r := mkroom('T2V2A', 2, 'playing');
  select id into p from public.tevatur_players
   where room_id = r and team = 'blue' and profile_id is not null
     and id <> (select host_player_id from public.tevatur_rooms where id = r) limit 1;
  if p is null then
    select id into p from public.tevatur_players where room_id = r and team = 'blue'
      and id <> (select host_player_id from public.tevatur_rooms where id = r) limit 1;
  end if;
  perform leave_as(r, p);
  insert into res(label,got,want) select '2v2 non-host: maç finished',
    (select status from public.tevatur_rooms where id = r), 'finished';
  insert into res(label,got,want) select '2v2 non-host: reason=abandoned',
    (select finished_reason from public.tevatur_rooms where id = r), 'abandoned';
  insert into res(label,got,want) select '2v2 non-host: finished_at yazıldı',
    (select (finished_at is not null)::text from public.tevatur_rooms where id = r), 'true';
  insert into res(label,got,want) select '2v2 non-host: phaseEndsAt null',
    (select coalesce(game_state->>'phaseEndsAt','NULL') from public.tevatur_rooms where id = r), 'NULL';
  insert into res(label,got,want) select '2v2 non-host: phase final_results OLMADI (XP tetiklenmez)',
    (select game_state->>'phase' from public.tevatur_rooms where id = r), 'observe_report';
  insert into res(label,got,want) select '2v2 non-host: ayrılan oyuncu adı kaydedildi',
    (select game_state->'abandonedBy'->>'name' from public.tevatur_rooms where id = r), 'blue2';
  insert into res(label,got,want) select '2v2 non-host: oyuncu satırı silindi',
    (select count(*)::text from public.tevatur_players where id = p), '0';
  insert into res(label,got,want) select '2v2 non-host: kalan 3 oyuncu odada',
    (select count(*)::text from public.tevatur_players where room_id = r), '3';
  insert into res(label,got,want) select '2v2 non-host: oda SİLİNMEDİ',
    (select count(*)::text from public.tevatur_rooms where id = r), '1';

  -- ════════ 2) idempotency — aynı çıkış ikinci kez ════════
  -- SÖZLEŞME: kimlik doğrulaması HER ZAMAN ilk adımdır. İlk çağrı oyuncu
  -- satırını sildiği için ikinci çağrı authorize'da düşer ve 'unauthorized'
  -- verir — bu, `tevatur_leave_room`un bugünkü davranışının AYNISIDIR ve
  -- kasıtlıdır: varlık kontrolünü authorize'ın ÖNÜNE almak, silinmiş bir
  -- player_id'yi sessizce "başarılı" saymak demek olurdu. Önemli olan
  -- güvenlik özelliği tekrarın DURUMU BOZAMAMASIDIR; aşağıdaki iki assert
  -- tam olarak onu kilitler. İstemci tarafında bu çağrı zaten tek-atış
  -- (`if (leaving) return`) ve hata yalnız console'a düşer.
  s := leave_as(r, p);
  insert into res(label,got,want) select 'çift çıkış: reddedildi (authorize-first korunuyor)',
    (case when s like '%unauthorized%' then 'unauthorized' else s end), 'unauthorized';
  insert into res(label,got,want) select 'çift çıkış: oda değişmedi',
    (select finished_reason from public.tevatur_rooms where id = r), 'abandoned';
  insert into res(label,got,want) select 'çift çıkış: kalan sayı değişmedi',
    (select count(*)::text from public.tevatur_players where room_id = r), '3';

  -- ════════ 3) 2v2 · HOST çıkışı → aynı terminal + host devri ════════
  r := mkroom('T2V2B', 2, 'playing');
  select host_player_id into host from public.tevatur_rooms where id = r;
  perform leave_as(r, host);
  insert into res(label,got,want) select '2v2 host: maç finished',
    (select status from public.tevatur_rooms where id = r), 'finished';
  insert into res(label,got,want) select '2v2 host: reason=abandoned',
    (select finished_reason from public.tevatur_rooms where id = r), 'abandoned';
  insert into res(label,got,want) select '2v2 host: oda SİLİNMEDİ (kalanlar ekranı okuyabilsin)',
    (select count(*)::text from public.tevatur_rooms where id = r), '1';
  insert into res(label,got,want) select '2v2 host: host devredildi (kayıtlı adaya)',
    (select (host_player_id is not null and host_player_id <> host)::text
       from public.tevatur_rooms where id = r), 'true';

  -- ════════ 4) 2v2 · MİSAFİR çıkışı → aynı kural ════════
  r := mkroom('T2V2C', 2, 'playing');
  select id into g from public.tevatur_players
   where room_id = r and guest_id is not null limit 1;
  perform leave_as(r, g);
  insert into res(label,got,want) select 'misafir çıkışı: maç finished (kayıtlıyla aynı)',
    (select status from public.tevatur_rooms where id = r), 'finished';
  insert into res(label,got,want) select 'misafir çıkışı: reason=abandoned',
    (select finished_reason from public.tevatur_rooms where id = r), 'abandoned';

  -- ════════ 5) 3v3 · bir çıkış maçı BİTİRMEZ (takım hâlâ 2) ════════
  r := mkroom('T3V3A', 3, 'playing');
  select id into p from public.tevatur_players
   where room_id = r and team = 'red' and name = 'red3' limit 1;
  perform leave_as(r, p);
  insert into res(label,got,want) select '3v3 ilk çıkış: maç DEVAM ediyor',
    (select status from public.tevatur_rooms where id = r), 'playing';
  insert into res(label,got,want) select '3v3 ilk çıkış: kırmızı takım 2 kişi',
    (select count(*)::text from public.tevatur_players where room_id = r and team = 'red'), '2';
  insert into res(label,got,want) select '3v3 ilk çıkış: teams dizisi kırpıldı',
    (select jsonb_array_length(game_state->'teams'->'red') ::text
       from public.tevatur_rooms where id = r), '2';
  insert into res(label,got,want) select '3v3 ilk çıkış: detectiveOrder kırpıldı',
    (select jsonb_array_length(game_state->'detectiveOrder'->'red')::text
       from public.tevatur_rooms where id = r), '2';
  insert into res(label,got,want) select '3v3 ilk çıkış: ayrılan id teams''te YOK',
    (select (game_state->'teams'->'red' @> to_jsonb(p::text))::text
       from public.tevatur_rooms where id = r), 'false';
  insert into res(label,got,want) select '3v3 ilk çıkış: mavi takım dokunulmadı',
    (select jsonb_array_length(game_state->'teams'->'blue')::text
       from public.tevatur_rooms where id = r), '3';
  insert into res(label,got,want) select '3v3 ilk çıkış: terminal reason YAZILMADI',
    (select coalesce(finished_reason,'NULL') from public.tevatur_rooms where id = r), 'NULL';

  -- ════════ 6) 3v3 · İKİNCİ çıkış aynı takımdan → 1'e düşer → terminal ════════
  select id into p from public.tevatur_players
   where room_id = r and team = 'red' and name = 'red2' limit 1;
  perform leave_as(r, p);
  insert into res(label,got,want) select '3v3 ikinci çıkış: maç finished',
    (select status from public.tevatur_rooms where id = r), 'finished';
  insert into res(label,got,want) select '3v3 ikinci çıkış: reason=abandoned',
    (select finished_reason from public.tevatur_rooms where id = r), 'abandoned';
  insert into res(label,got,want) select '3v3 ikinci çıkış: kırmızıda 1 kişi kaldı',
    (select count(*)::text from public.tevatur_players where room_id = r and team = 'red'), '1';

  -- ════════ 7) GÜVENLİK · cross-room ════════
  r  := mkroom('TXR1', 2, 'playing');
  r2 := mkroom('TXR2', 2, 'playing');
  select id into p from public.tevatur_players where room_id = r2 limit 1;
  s := leave_as(r, p);   -- r2'nin oyuncusu, r odasını bitirmeye çalışıyor
  insert into res(label,got,want) select 'cross-room: yabancı oda BİTMEDİ',
    (select status from public.tevatur_rooms where id = r), 'playing';
  insert into res(label,got,want) select 'cross-room: yabancı odada reason yok',
    (select coalesce(finished_reason,'NULL') from public.tevatur_rooms where id = r), 'NULL';
  insert into res(label,got,want) select 'cross-room: çağıranın KENDİ odası da bozulmadı',
    (select status from public.tevatur_rooms where id = r2), 'playing';
  insert into res(label,got,want) select 'cross-room: çağıranın satırı silinmedi',
    (select count(*)::text from public.tevatur_players where id = p), '1';

  -- ════════ 8) GÜVENLİK · yanlış claim token ════════
  select id into p from public.tevatur_players
   where room_id = r and guest_id is not null limit 1;
  s := leave_as(r, p, gen_random_uuid());
  insert into res(label,got,want) select 'yanlış token: unauthorized',
    (case when s like '%unauthorized%' then 'unauthorized' else s end), 'unauthorized';
  insert into res(label,got,want) select 'yanlış token: oda bozulmadı',
    (select status from public.tevatur_rooms where id = r), 'playing';

  -- ════════ 9) LOBİ REGRESYONU · status='waiting' ════════
  r := mkroom('TLOBBY', 2, 'waiting');
  select id into p from public.tevatur_players
   where room_id = r and id <> (select host_player_id from public.tevatur_rooms where id = r) limit 1;
  perform leave_as(r, p);
  insert into res(label,got,want) select 'lobi çıkışı: oda hâlâ waiting',
    (select status from public.tevatur_rooms where id = r), 'waiting';
  insert into res(label,got,want) select 'lobi çıkışı: terkediş ÜRETİLMEDİ',
    (select coalesce(finished_reason,'NULL') from public.tevatur_rooms where id = r), 'NULL';
  insert into res(label,got,want) select 'lobi çıkışı: oyuncu satırı silindi (eski davranış)',
    (select count(*)::text from public.tevatur_players where id = p), '0';
  insert into res(label,got,want) select 'lobi çıkışı: game_state yazılmadı',
    (select coalesce(game_state::text,'NULL') from public.tevatur_rooms where id = r), 'NULL';

  -- ════════ 10) TERMİNAL REGRESYONU · bitmiş maçtan çıkış ════════
  r := mkroom('TFIN', 2, 'playing');
  update public.tevatur_rooms
     set status = 'finished', finished_reason = 'completed',
         game_state = jsonb_set(game_state, '{phase}', '"final_results"')
   where id = r;
  select id into p from public.tevatur_players
   where room_id = r and id <> (select host_player_id from public.tevatur_rooms where id = r) limit 1;
  perform leave_as(r, p);
  insert into res(label,got,want) select 'bitmiş maç: reason YENİDEN yazılmadı',
    (select finished_reason from public.tevatur_rooms where id = r), 'completed';
  insert into res(label,got,want) select 'bitmiş maç: phase korundu',
    (select game_state->>'phase' from public.tevatur_rooms where id = r), 'final_results';
  insert into res(label,got,want) select 'bitmiş maç: oyuncu satırı silindi (eski davranış)',
    (select count(*)::text from public.tevatur_players where id = p), '0';

  -- ════════ 11) minimum yaşayabilir takım kuralı ════════
  insert into res(label,got,want) select 'minimum yaşayabilir takım = 2',
    public.tevatur_kn_min_viable_team_size()::text, '2';
end$suite$;

select label || '|' || coalesce(got,'<null>') || '|' || want from res order by ord;
