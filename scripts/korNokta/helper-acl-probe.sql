-- Kör Nokta yardımcı-ACL probe'ları. Kendi kendine yeter (kendi fixture'ını
-- kurar). `label|got|want` satırları basar. Yalnız yerel clean-room.

create temp table aclres(ord serial, label text, got text, want text);

/* ── Fixture: canlı 2v2 (1 kayıtlı + 1 misafir / takım) ── */
create temp table fx(room uuid, reg uuid, guest uuid, reg_uid uuid);

do $setup$
declare
  v_room uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid();  -- kayıtlı (host)
  b2 uuid := gen_random_uuid();  -- misafir
  r1 uuid := gen_random_uuid();
  r2 uuid := gen_random_uuid();
begin
  insert into public.tevatur_rooms(id, code, status, host_player_id, game_state)
  values (v_room, 'ACL2V2', 'playing', b1, jsonb_build_object(
    'version', 3, 'roundCount', 5, 'roundIndex', 0,
    'phase', 'observe_report', 'phaseEndsAt', 9999999999999::bigint,
    'teams', jsonb_build_object('blue', jsonb_build_array(b1::text, b2::text),
                                'red',  jsonb_build_array(r1::text, r2::text)),
    'detectiveOrder', jsonb_build_object('blue', jsonb_build_array(b1::text, b2::text),
                                         'red',  jsonb_build_array(r1::text, r2::text)),
    'totals', jsonb_build_object('blue', 0, 'red', 0),
    'rounds', jsonb_build_array(jsonb_build_object('sceneId','kn_001'))));

  insert into public.tevatur_players(id, room_id, profile_id, guest_id, name, team) values
    (b1, v_room, b1,   null,        'blue1', 'blue'),
    (b2, v_room, null, 'g-'||b2,    'blue2', 'blue'),
    (r1, v_room, r1,   null,        'red1',  'red'),
    (r2, v_room, null, 'g-'||r2,    'red2',  'red');
  insert into public.tevatur_player_claims(player_id, claim_token) values
    (b1,b1),(b2,b2),(r1,r1),(r2,r2);

  insert into fx values (v_room, r1, r2, r1);
end$setup$;

/* Probe'lar fonksiyonla sarılır: DO bloğu değer döndüremez, oysa bize
   "izin verildi mi, reddedildi mi" cevabı lazım. Rol her probe'un içinde
   `set local role` ile değiştirilip çıkarken geri alınır. */
create or replace function probe_helper(p_role text) returns text
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform public.tevatur_kn_min_viable_team_size();
  reset role;
  return 'allowed';
exception when insufficient_privilege then
  reset role; return 'denied';
when others then
  reset role; return 'err:' || sqlstate;
end$$;

/* Çıkış RPC'si o rolden çağrılabiliyor mu (SECURITY DEFINER içinden yardımcı
   çözülüyor mu) — asıl uyumluluk sorusu budur. */
create or replace function probe_leave(p_role text, p_room uuid, p_player uuid, p_uid uuid)
returns text language plpgsql as $$
begin
  perform set_config('torble.uid', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  perform public.tevatur_kn_leave_match(p_room, p_player, p_player);
  reset role;
  return 'ok';
exception when others then
  reset role; return 'err:' || sqlstate || ':' || sqlerrm;
end$$;

do $suite$
declare v_room uuid; v_reg uuid; v_guest uuid; v_uid uuid;
begin
  select room, reg, guest, reg_uid into v_room, v_reg, v_guest, v_uid from fx;

  -- ── Yardımcı: istemci rollerinden DOĞRUDAN çağrılamamalı ──
  insert into aclres(label,got,want) select
    'anon DOĞRUDAN yardımcı çağrısı reddedildi', probe_helper('anon'), 'denied';
  insert into aclres(label,got,want) select
    'authenticated DOĞRUDAN yardımcı çağrısı reddedildi', probe_helper('authenticated'), 'denied';

  -- ── has_function_privilege ile ACL'in kendisi ──
  insert into aclres(label,got,want) select
    'yardımcı: anon EXECUTE yok',
    has_function_privilege('anon', 'public.tevatur_kn_min_viable_team_size()', 'execute')::text, 'false';
  insert into aclres(label,got,want) select
    'yardımcı: authenticated EXECUTE yok',
    has_function_privilege('authenticated', 'public.tevatur_kn_min_viable_team_size()', 'execute')::text, 'false';
  insert into aclres(label,got,want) select
    'yardımcı: PUBLIC EXECUTE yok',
    has_function_privilege('public', 'public.tevatur_kn_min_viable_team_size()', 'execute')::text, 'false';

  -- ── Yardımcının KİMLİĞİ değişmemiş olmalı ──
  insert into aclres(label,got,want) select
    'yardımcı SECURITY DEFINER YAPILMADI',
    (select prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tevatur_kn_min_viable_team_size'), 'false';
  insert into aclres(label,got,want) select
    'yardımcıya search_path EKLENMEDİ',
    (select coalesce(proconfig::text,'NULL') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tevatur_kn_min_viable_team_size'), 'NULL';
  insert into aclres(label,got,want) select
    'yardımcı hâlâ 0 argümanlı / immutable',
    (select pronargs::text || provolatile::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tevatur_kn_min_viable_team_size'), '0i';
  insert into aclres(label,got,want) select
    'yardımcı gövdesi değişmedi (select 2)',
    (select (prosrc like '%select 2;%')::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tevatur_kn_min_viable_team_size'), 'true';

  -- ── Çıkış RPC'si ve komşuları DOKUNULMAMIŞ olmalı ──
  insert into aclres(label,got,want) select
    'leave_match: anon EXECUTE KORUNDU',
    has_function_privilege('anon', 'public.tevatur_kn_leave_match(uuid,uuid,uuid)', 'execute')::text, 'true';
  insert into aclres(label,got,want) select
    'leave_match: authenticated EXECUTE KORUNDU',
    has_function_privilege('authenticated', 'public.tevatur_kn_leave_match(uuid,uuid,uuid)', 'execute')::text, 'true';
  insert into aclres(label,got,want) select
    'authorize_player: anon EXECUTE KORUNDU',
    has_function_privilege('anon', 'public.tevatur_authorize_player(uuid,uuid)', 'execute')::text, 'true';
  insert into aclres(label,got,want) select
    'leave_room: anon EXECUTE KORUNDU',
    has_function_privilege('anon', 'public.tevatur_leave_room(uuid,uuid,uuid)', 'execute')::text, 'true';

  -- ── ASIL UYUMLULUK: definer gövdesinden yardımcı hâlâ çözülüyor mu? ──
  -- MİSAFİR, anon rolüyle canlı 2v2'den çıkıyor → maç terminal olmalı.
  insert into aclres(label,got,want) select
    'MİSAFİR anon rolüyle çıkış RPC''sini çağırabiliyor',
    probe_leave('anon', v_room, v_guest, null), 'ok';
  insert into aclres(label,got,want) select
    '2v2 misafir çıkışı → maç abandoned (yardımcı definer içinden çalıştı)',
    (select finished_reason from public.tevatur_rooms where id = v_room), 'abandoned';
  insert into aclres(label,got,want) select
    '2v2 misafir çıkışı → status finished',
    (select status from public.tevatur_rooms where id = v_room), 'finished';
end$suite$;

/* ── KAYITLI kullanıcı, authenticated rolüyle, TAZE bir 3v3'te ── */
do $reg$
declare
  v_room uuid := gen_random_uuid();
  ids uuid[] := array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
                      gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  blue jsonb; red jsonb; i int;
begin
  blue := to_jsonb(array[ids[1]::text, ids[2]::text, ids[3]::text]);
  red  := to_jsonb(array[ids[4]::text, ids[5]::text, ids[6]::text]);
  insert into public.tevatur_rooms(id, code, status, host_player_id, game_state)
  values (v_room, 'ACL3V3', 'playing', ids[1], jsonb_build_object(
    'version',3,'roundCount',5,'roundIndex',0,'phase','observe_report',
    'phaseEndsAt', 9999999999999::bigint,
    'teams', jsonb_build_object('blue',blue,'red',red),
    'detectiveOrder', jsonb_build_object('blue',blue,'red',red),
    'totals', jsonb_build_object('blue',0,'red',0),
    'rounds', jsonb_build_array(jsonb_build_object('sceneId','kn_001'))));
  for i in 1..6 loop
    insert into public.tevatur_players(id, room_id, profile_id, name, team)
    values (ids[i], v_room, ids[i], 'p'||i, case when i<=3 then 'blue' else 'red' end);
    insert into public.tevatur_player_claims(player_id, claim_token) values (ids[i], ids[i]);
  end loop;

  insert into aclres(label,got,want) select
    'KAYITLI authenticated rolüyle çıkış RPC''sini çağırabiliyor',
    probe_leave('authenticated', v_room, ids[6], ids[6]), 'ok';
  insert into aclres(label,got,want) select
    '3v3 ilk çıkış → maç DEVAM ediyor (yardımcı eşiği okundu)',
    (select status from public.tevatur_rooms where id = v_room), 'playing';
  insert into aclres(label,got,want) select
    '3v3 ilk çıkış → terminal reason yazılmadı',
    (select coalesce(finished_reason,'NULL') from public.tevatur_rooms where id = v_room), 'NULL';

  -- İkinci çıkış aynı takımdan → 1'e düşer → yardımcı eşiği tetiklenmeli.
  insert into aclres(label,got,want) select
    '3v3 ikinci çıkış çağrılabildi',
    probe_leave('authenticated', v_room, ids[5], ids[5]), 'ok';
  insert into aclres(label,got,want) select
    '3v3 ikinci çıkış → abandoned (eşik definer içinden uygulandı)',
    (select finished_reason from public.tevatur_rooms where id = v_room), 'abandoned';
end$reg$;

select label || '|' || coalesce(got,'<null>') || '|' || want from aclres order by ord;
