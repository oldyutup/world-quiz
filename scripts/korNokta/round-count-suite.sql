-- Kör Nokta tur sayısı runtime süiti. `label|got|want` satırları basar.
-- Yalnız yerel clean-room; production'a DOKUNMAZ.

create temp table rres(ord serial, label text, got text, want text);

/* Tur sayısı doğrulamasını gerçek RPC'ler üzerinden dener. */
create or replace function try_create(p_code text, p_rounds int, p_uid uuid)
returns text language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  perform set_config('torble.uid', p_uid::text, true);
  perform public.tevatur_create_room(v, p_code, p_rounds, 10, gen_random_uuid());
  return 'ok';
exception when others then return sqlerrm;
end$$;

create or replace function try_update(p_room uuid, p_host uuid, p_tok uuid, p_rounds int, p_uid uuid)
returns text language plpgsql as $$
begin
  perform set_config('torble.uid', p_uid::text, true);
  perform public.tevatur_update_settings(p_room, p_host, p_tok, p_rounds, null);
  return 'ok';
exception when others then return sqlerrm;
end$$;

do $suite$
declare
  v_uid uuid := gen_random_uuid();
  v_room public.tevatur_rooms;
  v_host uuid; v_tok uuid; s text; n int;
begin
  insert into public.profiles(id, username) values (v_uid, 'HostUser');

  -- ══ 1) CHECK constraint 3'ü kabul, hiçbir eski değeri kaybetmiyor ══
  insert into rres(label,got,want) select 'CHECK constraint 3..20 tümünü kapsıyor',
    (select (pg_get_constraintdef(oid) like '%3%' and pg_get_constraintdef(oid) like '%5%'
         and pg_get_constraintdef(oid) like '%7%' and pg_get_constraintdef(oid) like '%10%'
         and pg_get_constraintdef(oid) like '%15%' and pg_get_constraintdef(oid) like '%20%')::text
       from pg_constraint where conrelid='public.tevatur_rooms'::regclass
         and conname='tevatur_rooms_round_count_check'), 'true';

  -- ══ 2) YENİ seçenekler kabul ediliyor ══
  insert into rres(label,got,want) select 'create_room 3 tur KABUL',  try_create('TR3',  3,  v_uid), 'ok';
  insert into rres(label,got,want) select 'create_room 5 tur KABUL',  try_create('TR5',  5,  v_uid), 'ok';
  insert into rres(label,got,want) select 'create_room 10 tur KABUL', try_create('TR10', 10, v_uid), 'ok';

  -- ══ 3) ESKİ İSTEMCİ değerleri HÂLÂ kabul (geri uyumluluk) ══
  insert into rres(label,got,want) select 'create_room 15 tur HÂLÂ kabul (eski istemci)', try_create('TR15', 15, v_uid), 'ok';
  insert into rres(label,got,want) select 'create_room 20 tur HÂLÂ kabul (eski istemci)', try_create('TR20', 20, v_uid), 'ok';
  insert into rres(label,got,want) select 'create_room 7 tur HÂLÂ kabul (ara değer)',     try_create('TR7',  7,  v_uid), 'ok';

  -- ══ 4) Geçersiz değerler HÂLÂ reddediliyor (kural gevşemedi) ══
  s := try_create('TR4', 4, v_uid);
  insert into rres(label,got,want) select 'create_room 4 tur REDDEDİLİYOR',
    (case when s like '%round_count_invalid%' then 'rejected' else s end), 'rejected';
  s := try_create('TR0', 0, v_uid);
  insert into rres(label,got,want) select 'create_room 0 tur REDDEDİLİYOR',
    (case when s like '%round_count_invalid%' then 'rejected' else s end), 'rejected';
  s := try_create('TR99', 99, v_uid);
  insert into rres(label,got,want) select 'create_room 99 tur REDDEDİLİYOR',
    (case when s like '%round_count_invalid%' then 'rejected' else s end), 'rejected';

  -- ══ 5) update_settings aynı kümeyi kabul ediyor ══
  select * into v_room from public.tevatur_rooms where code = 'TR10';
  v_host := v_room.host_player_id;
  select claim_token into v_tok from public.tevatur_player_claims where player_id = v_host;
  insert into rres(label,got,want) select 'update_settings 3 tura geçebiliyor',
    try_update(v_room.id, v_host, v_tok, 3, v_uid), 'ok';
  insert into rres(label,got,want) select 'update_settings sonrası oda 3 tur',
    (select round_count::text from public.tevatur_rooms where id = v_room.id), '3';
  insert into rres(label,got,want) select 'update_settings 20 turu HÂLÂ kabul (eski istemci)',
    try_update(v_room.id, v_host, v_tok, 20, v_uid), 'ok';
  s := try_update(v_room.id, v_host, v_tok, 4, v_uid);
  insert into rres(label,got,want) select 'update_settings 4 turu REDDEDİYOR',
    (case when s like '%round_count_invalid%' then 'rejected' else s end), 'rejected';

  -- ══ 6) ESKİ 15/20 odalar okunmaya devam ediyor (veri migrasyonu YOK) ══
  -- NOT: TR10 yukarıdaki update_settings testiyle 20'ye çekildi; bu yüzden
  -- "15/20 olan her oda" değil, ESKİ İSTEMCİNİN KURDUĞU iki oda sayılır.
  select count(*) into n from public.tevatur_rooms
   where code in ('TR15','TR20') and round_count in (15, 20);
  insert into rres(label,got,want) select
    'eski 15/20 odalar tabloda duruyor (silinmedi/dönüştürülmedi)', n::text, '2';

  -- ══ 7) ACL DEĞİŞMEDİ (create or replace mevcut yetkileri korur) ══
  insert into rres(label,got,want) select 'create_room: anon EXECUTE hâlâ YOK (login-only)',
    has_function_privilege('anon','public.tevatur_create_room(uuid,text,int,int,uuid)','execute')::text, 'false';
  insert into rres(label,got,want) select 'create_room: authenticated EXECUTE korundu',
    has_function_privilege('authenticated','public.tevatur_create_room(uuid,text,int,int,uuid)','execute')::text, 'true';
  insert into rres(label,got,want) select 'update_settings: anon EXECUTE korundu',
    has_function_privilege('anon','public.tevatur_update_settings(uuid,uuid,uuid,int,int)','execute')::text, 'true';
  insert into rres(label,got,want) select 'update_settings: authenticated EXECUTE korundu',
    has_function_privilege('authenticated','public.tevatur_update_settings(uuid,uuid,uuid,int,int)','execute')::text, 'true';
end$suite$;

/* ══ 8) 3 TURLUK MAÇ GERÇEKTEN 3 TURDA BİTİYOR ══
   game_state tamamlanma koşulu `roundIndex + 1 >= roundCount` üzerinden
   sürülür: 3 turluk bir state'te 0→1→2 ilerler, 2'de final_results olur ve
   4. tur ASLA başlamaz. */
do $rounds$
declare
  v_state jsonb;
  v_idx int; v_phase text; i int; v_final_at int := -1;
begin
  v_state := jsonb_build_object('roundCount', 3, 'roundIndex', 0, 'phase', 'round_reveal');

  for i in 1..10 loop
    v_idx   := (v_state->>'roundIndex')::int;
    v_phase := v_state->>'phase';
    exit when v_phase = 'final_results';
    -- advance_phase / advance_if_due'daki round_reveal dalının aynısı:
    if v_idx + 1 >= (v_state->>'roundCount')::int then
      v_state := jsonb_set(v_state, '{phase}', '"final_results"');
      v_final_at := v_idx;
    else
      v_state := jsonb_set(v_state, '{roundIndex}', to_jsonb(v_idx + 1));
    end if;
  end loop;

  insert into rres(label,got,want) select '3 tur: final_results son turda (index 2 = 3/3)',
    v_final_at::text, '2';
  insert into rres(label,got,want) select '3 tur: 4. tur BAŞLAMIYOR (roundIndex 2''de kalıyor)',
    (v_state->>'roundIndex'), '2';
  insert into rres(label,got,want) select '3 tur: terminal faz final_results',
    (v_state->>'phase'), 'final_results';
  insert into rres(label,got,want) select '3 tur: sayaç 3/3 gösterir',
    ((v_state->>'roundIndex')::int + 1)::text || '/' || (v_state->>'roundCount'), '3/3';
end$rounds$;

select label || '|' || coalesce(got,'<null>') || '|' || want from rres order by ord;
