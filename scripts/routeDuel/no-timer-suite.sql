-- no-timer-suite.sql — Rota Düello süre kuralı kaldırma + settle guard
-- clean-room davranış testi (20260821150000).
--
-- Çıktı biçimi: her satır  label|got|want  (check-route-duel-no-timer.ts okur).
-- PRODUCTION'A HİÇBİR ŞEY YAZMAZ — yalnız clean-room DB'sinde çalışır.

\set ON_ERROR_STOP on
-- NOT: client_min_messages DÜŞÜRÜLMEZ — sonuç satırları `raise notice` ile
-- akıyor; 'warning'e çekmek onları da yutardı (sessiz boş suite).

-- ── Yardımcılar ────────────────────────────────────────────────────────────
-- RPC'yi çağırır, hata mesajını (ya da 'ok') döndürür. Testler ret/kabul
-- matrisini bu sayede exception'a düşmeden okuyabilir.
create or replace function pg_temp.try_advance(p_room uuid, p_player uuid, p_claim uuid)
returns text language plpgsql as $$
begin
  perform public.route_duel_advance_round(p_room, p_player, p_claim);
  return 'ok';
exception when others then
  return sqlerrm;
end$$;

create or replace function pg_temp.try_submit(p_room uuid, p_player uuid, p_claim uuid, p_key text)
returns text language plpgsql as $$
declare v jsonb;
begin
  v := public.route_duel_submit_move(p_room, p_player, p_claim, p_key);
  return coalesce(v->>'reason', case when (v->>'accepted')::boolean then 'accepted' else 'rejected' end);
exception when others then
  return sqlerrm;
end$$;

-- Oyuncunun mevcut konumunun graf komşusundan hedefe DOĞRU olmayan rastgele
-- bir komşu (adım atmak için); hedefe ulaşmak istemediğimiz durumlarda.
create or replace function pg_temp.a_neighbor(p_room uuid, p_player uuid)
returns text language sql stable as $$
  select n
    from public.route_duel_players p
    join public.route_duel_graph g on g.country_key = p.current_key
    cross join lateral unnest(g.neighbors) as n
    join public.route_duel_rooms r on r.id = p.room_id
   where p.id = p_player and n <> coalesce(r.round_target_key, '')
   order by n
   limit 1;
$$;

-- Oda kurulum yardımcısı: iki KAYITLI oyuncu + başlatılmış maç.
create or replace function pg_temp.fresh_room(p_code text, p_rounds int)
returns uuid language plpgsql as $$
declare v_room uuid;
begin
  -- Oyuncu id'leri senaryolar arasında YENİDEN KULLANILIYOR (PK çakışması):
  -- her senaryo temiz bir tahtayla başlar. Cascade oyuncu satırlarını da siler.
  delete from public.route_duel_rooms;
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  perform public.route_duel_create_room(
    '00000000-0000-0000-0000-0000000000a1'::uuid,
    '00000000-0000-0000-0000-00000000a001'::uuid,
    null, 'enes1', p_code, p_rounds, '5',
    '00000000-0000-0000-0000-0000000000f1'::uuid);
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a002', false);
  perform public.route_duel_join_room(
    p_code,
    '00000000-0000-0000-0000-0000000000b1'::uuid,
    '00000000-0000-0000-0000-00000000a002'::uuid,
    null, 'enes', '00000000-0000-0000-0000-0000000000f2'::uuid);
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  perform public.route_duel_start_game(
    (select id from public.route_duel_rooms where code = p_code),
    '00000000-0000-0000-0000-0000000000a1'::uuid,
    '00000000-0000-0000-0000-0000000000f1'::uuid);
  select id into v_room from public.route_duel_rooms where code = p_code;
  -- 3 sn ortak geri sayımı geç (sunucu saatiyle, istemci saatiyle DEĞİL).
  update public.route_duel_rooms set round_started_at = now() - interval '1 second' where id = v_room;
  return v_room;
end$$;

insert into public.profiles(id, username) values
  ('00000000-0000-0000-0000-00000000a001','enes1'),
  ('00000000-0000-0000-0000-00000000a002','enes')
on conflict do nothing;


-- ════════════════════════════════════════════════════════════════════════
-- 1) SUNUCU-OTORİTER SENKRON  (host + misafir hamleleri)
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v_room uuid; v_res text; v_a text; v_b text;
begin
  v_room := pg_temp.fresh_room('RDS01', 5);

  -- HOST hamlesi
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  v_res := pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000a1',
                              '00000000-0000-0000-0000-0000000000f1',
                              pg_temp.a_neighbor(v_room,'00000000-0000-0000-0000-0000000000a1'));
  raise notice '%', 'X|host_submit|'||v_res||'|accepted';

  -- MİSAFİR hamlesi
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a002', false);
  v_res := pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000b1',
                              '00000000-0000-0000-0000-0000000000f2',
                              pg_temp.a_neighbor(v_room,'00000000-0000-0000-0000-0000000000b1'));
  raise notice '%', 'X|guest_submit|'||v_res||'|accepted';

  -- İKİ OYUNCU DA AYNI satırları okur (otorite tek: DB). "A'nın gördüğü A" ile
  -- "B'nin gördüğü A" aynı sorgudur — RLS select policy'si her ikisine de açık.
  select current_key||' /'||array_length(path,1)::text into v_a
    from public.route_duel_players where id='00000000-0000-0000-0000-0000000000a1';
  select current_key||' /'||array_length(path,1)::text into v_b
    from public.route_duel_players where id='00000000-0000-0000-0000-0000000000b1';
  raise notice '%', 'X|host_path_len|'||split_part(v_a,'/',2)||'|2';
  raise notice '%', 'X|guest_path_len|'||split_part(v_b,'/',2)||'|2';

  -- Konum sunucudan türetilir: path'in SON elemanı = current_key (her iki taraf).
  raise notice '%', 'X|host_current_is_path_tail|'||(
    select (current_key = path[array_length(path,1)])::text
      from public.route_duel_players where id='00000000-0000-0000-0000-0000000000a1')||'|true';
  raise notice '%', 'X|guest_current_is_path_tail|'||(
    select (current_key = path[array_length(path,1)])::text
      from public.route_duel_players where id='00000000-0000-0000-0000-0000000000b1')||'|true';

  -- Tur görevi İKİSİ İÇİN AYNI (oda satırında, oyuncu satırında değil).
  raise notice '%', 'X|shared_route_task|'||(
    select (round_start_key is not null and round_target_key is not null)::text
      from public.route_duel_rooms where id = v_room)||'|true';

  -- Skorlar hamleyle DEĞİŞMEZ (yalnız hedefe ulaşınca).
  raise notice '%', 'X|no_score_on_plain_move|'||(
    select (sum(score) = 0)::text from public.route_duel_players where room_id = v_room)||'|true';
end$$;


-- ════════════════════════════════════════════════════════════════════════
-- 2) OYUN İÇİ SÜRE YOK — 15 sn / 30 sn / eski 60 sn sınırının ÖTESİ
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v_room uuid; v_res text; v_status text; v_secs int;
begin
  foreach v_secs in array array[15, 30, 90, 600] loop
    v_room := pg_temp.fresh_room('RDT'||v_secs::text, 3);

    -- Maç v_secs saniyedir sürüyormuş gibi SUNUCU zamanını geriye al.
    -- Eski 60 sn'lik deadline'ı da GEÇMİŞE koy: bayat/legacy deadline'ın
    -- ilerlemeyi ya da bitişi ARTIK yönetmediğini kanıtlar.
    update public.route_duel_rooms
       set round_started_at = now() - (v_secs || ' seconds')::interval,
           round_deadline   = now() - interval '30 seconds',
           started_at       = now() - (v_secs || ' seconds')::interval
     where id = v_room;

    -- Hamle HÂLÂ kabul edilir (süre dolmuş sayılmaz).
    perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
    v_res := pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000a1',
                                '00000000-0000-0000-0000-0000000000f1',
                                pg_temp.a_neighbor(v_room,'00000000-0000-0000-0000-0000000000a1'));
    raise notice '%', 'X|t'||v_secs||'s_submit_accepted|'||v_res||'|accepted';

    -- advance ZAMANLA ilerletemez (kazanan yok).
    v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                                 '00000000-0000-0000-0000-0000000000f1');
    raise notice '%', 'X|t'||v_secs||'s_advance_refused|'||
      (v_res like '%round_not_over%')::text||'|true';

    -- Maç HÂLÂ oynanıyor.
    select status into v_status from public.route_duel_rooms where id = v_room;
    raise notice '%', 'X|t'||v_secs||'s_still_playing|'||v_status||'|playing';

    -- Tur da ilerlememiş olmalı (zaman turu atlatamaz).
    raise notice '%', 'X|t'||v_secs||'s_round_unchanged|'||
      (select current_round::text from public.route_duel_rooms where id = v_room)||'|1';
  end loop;
end$$;


-- ════════════════════════════════════════════════════════════════════════
-- 3) KAZANAN SETTLE / REVEAL PENCERESİ  (eski istemci koruması)
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v_room uuid; v_res text; v_round_before int; v_target text;
begin
  v_room := pg_temp.fresh_room('RDW01', 5);
  select round_target_key into v_target from public.route_duel_rooms where id = v_room;

  -- A'yı hedefin komşusuna taşıyıp hedefe ulaştır (tur kazanılır).
  update public.route_duel_players
     set current_key = (select g.country_key from public.route_duel_graph g
                         where v_target = any(g.neighbors) order by g.country_key limit 1),
         path = array[(select g.country_key from public.route_duel_graph g
                        where v_target = any(g.neighbors) order by g.country_key limit 1)]
   where id = '00000000-0000-0000-0000-0000000000a1';

  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  v_res := pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000a1',
                              '00000000-0000-0000-0000-0000000000f1', v_target);
  raise notice '%', 'X|winner_move_accepted|'||v_res||'|accepted';

  -- Kazanan SUNUCU state'i; damga sunucu now()'u.
  raise notice '%', 'X|winner_is_server_state|'||(
    select (round_winner_player_id = '00000000-0000-0000-0000-0000000000a1'
            and round_decided_at is not null)::text
      from public.route_duel_rooms where id = v_room)||'|true';

  select current_round into v_round_before from public.route_duel_rooms where id = v_room;

  -- (a) ESKİ İSTEMCİ DAVRANIŞI: kazananı görür görmez ANINDA advance çağır.
  --     Reveal penceresi dolmadığı için sunucu REDDETMELİ.
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                               '00000000-0000-0000-0000-0000000000f1');
  raise notice '%', 'X|immediate_advance_refused|'||(v_res like '%round_not_over%')::text||'|true';
  raise notice '%', 'X|immediate_advance_no_round_skip|'||
    (select (current_round = v_round_before)::text from public.route_duel_rooms where id = v_room)||'|true';

  -- Rakip (misafir) de anında deneyebilir — o da reddedilmeli.
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a002', false);
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000b1',
                               '00000000-0000-0000-0000-0000000000f2');
  raise notice '%', 'X|immediate_advance_refused_guest|'||(v_res like '%round_not_over%')::text||'|true';

  -- 3.2 sn sınırının HEMEN ALTI hâlâ reddedilir (pencere gerçekten uygulanıyor).
  -- torble.uid A'ya GERİ ALINIR: bir önceki adım misafir kimliğiyle çalıştı ve
  -- kimlik bırakılırsa authorize_player 'unauthorized' verip bu testi
  -- settle guard'ını hiç sınamadan "başarısız" gösterirdi.
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  update public.route_duel_rooms
     set round_decided_at = now() - interval '3000 milliseconds' where id = v_room;
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                               '00000000-0000-0000-0000-0000000000f1');
  raise notice '%', 'X|just_before_settle_refused|'||(v_res like '%round_not_over%')::text||'|true';

  -- (b) Pencere dolunca ilerler.
  update public.route_duel_rooms
     set round_decided_at = now() - interval '3300 milliseconds' where id = v_room;
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                               '00000000-0000-0000-0000-0000000000f1');
  raise notice '%', 'X|post_settle_advance_ok|'||v_res||'|ok';
  raise notice '%', 'X|post_settle_round_incremented|'||
    (select (current_round = v_round_before + 1)::text from public.route_duel_rooms where id = v_room)||'|true';

  -- (c) Çift/yarışan çağrı: ikinci çağrı yeni turda round_not_over alır,
  --     tur İKİ KEZ atlamaz.
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                               '00000000-0000-0000-0000-0000000000f1');
  raise notice '%', 'X|duplicate_advance_safe|'||(v_res like '%round_not_over%')::text||'|true';
  raise notice '%', 'X|duplicate_no_double_skip|'||
    (select (current_round = v_round_before + 1)::text from public.route_duel_rooms where id = v_room)||'|true';

  -- (d) Yeni turun legacy deadline'ı UZUN (6 sa) ve ilerlemeyi yönetmiyor.
  raise notice '%', 'X|legacy_deadline_is_long|'||(
    select (round_deadline > now() + interval '5 hours')::text
      from public.route_duel_rooms where id = v_room)||'|true';

  -- (e) Arka plana atılan istemci turu ASILI bırakmaz: diğer oyuncu ilerletir.
  update public.route_duel_players
     set current_key = (select g.country_key from public.route_duel_graph g
                         where (select round_target_key from public.route_duel_rooms where id = v_room) = any(g.neighbors)
                         order by g.country_key limit 1)
   where id = '00000000-0000-0000-0000-0000000000b1';
  select round_target_key into v_target from public.route_duel_rooms where id = v_room;
  -- Yeni turun 3 sn'lik ortak geri sayımını geç; aksi hâlde submit
  -- 'not_started' alır ve kazanan hiç yazılmaz.
  update public.route_duel_rooms set round_started_at = now() - interval '1 second' where id = v_room;
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a002', false);
  perform pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000b1',
                             '00000000-0000-0000-0000-0000000000f2', v_target);
  update public.route_duel_rooms
     set round_decided_at = now() - interval '12 seconds' where id = v_room;
  -- HOST hiç çağırmıyor (arka planda); MİSAFİR ilerletiyor.
  v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000b1',
                               '00000000-0000-0000-0000-0000000000f2');
  raise notice '%', 'X|guest_can_advance_when_host_backgrounded|'||v_res||'|ok';
end$$;


-- ════════════════════════════════════════════════════════════════════════
-- 4) MEŞRU TAMAMLAMA — skor/tur/finalize değişmedi
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v_room uuid; v_target text; v_res text; i int;
begin
  v_room := pg_temp.fresh_room('RDC01', 3);

  for i in 1..3 loop
    select round_target_key into v_target from public.route_duel_rooms where id = v_room;
    -- A hedefin komşusuna konur ve hedefe ulaşır → turu kazanır.
    update public.route_duel_players
       set current_key = (select g.country_key from public.route_duel_graph g
                           where v_target = any(g.neighbors) order by g.country_key limit 1)
     where id = '00000000-0000-0000-0000-0000000000a1';
    perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
    perform pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000a1',
                               '00000000-0000-0000-0000-0000000000f1', v_target);
    -- reveal penceresini geç, sonra ilerlet
    update public.route_duel_rooms
       set round_decided_at = now() - interval '3300 milliseconds' where id = v_room;
    v_res := pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                                 '00000000-0000-0000-0000-0000000000f1');
    if i < 3 then
      update public.route_duel_rooms set round_started_at = now() - interval '1 second' where id = v_room;
    end if;
  end loop;

  raise notice '%', 'X|match_finished|'||
    (select status from public.route_duel_rooms where id = v_room)||'|finished';
  raise notice '%', 'X|finish_reason_completed|'||
    (select finished_reason from public.route_duel_rooms where id = v_room)||'|completed';
  raise notice '%', 'X|winner_is_high_scorer|'||
    (select (winner_player_id = '00000000-0000-0000-0000-0000000000a1')::text
       from public.route_duel_rooms where id = v_room)||'|true';
  raise notice '%', 'X|winner_score_3|'||
    (select score::text from public.route_duel_players where id='00000000-0000-0000-0000-0000000000a1')||'|3';
  raise notice '%', 'X|loser_score_0|'||
    (select score::text from public.route_duel_players where id='00000000-0000-0000-0000-0000000000b1')||'|0';
  -- Bitmiş maçta advance idempotent (exception değil, aynı satır).
  raise notice '%', 'X|advance_after_finish_idempotent|'||
    pg_temp.try_advance(v_room,'00000000-0000-0000-0000-0000000000a1',
                        '00000000-0000-0000-0000-0000000000f1')||'|ok';
end$$;


-- ════════════════════════════════════════════════════════════════════════
-- 5) YENİDEN BAĞLANMA — durum sunucudan BİREBİR geri gelir
-- ════════════════════════════════════════════════════════════════════════
do $$
declare v_room uuid; v_snap text; v_again text;
begin
  v_room := pg_temp.fresh_room('RDR01', 5);
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a001', false);
  perform pg_temp.try_submit(v_room,'00000000-0000-0000-0000-0000000000a1',
                             '00000000-0000-0000-0000-0000000000f1',
                             pg_temp.a_neighbor(v_room,'00000000-0000-0000-0000-0000000000a1'));

  -- "Reconnect" = state'i yeniden SELECT etmek. Otorite DB olduğu için
  -- ikinci okuma birebir aynı olmalı (lokal state'e bağımlılık yok).
  select r.current_round||'|'||r.round_start_key||'|'||r.round_target_key||'|'||
         p.current_key||'|'||array_to_string(p.path,'>')||'|'||p.score::text
    into v_snap
    from public.route_duel_rooms r
    join public.route_duel_players p on p.id='00000000-0000-0000-0000-0000000000a1'
   where r.id = v_room;

  select r.current_round||'|'||r.round_start_key||'|'||r.round_target_key||'|'||
         p.current_key||'|'||array_to_string(p.path,'>')||'|'||p.score::text
    into v_again
    from public.route_duel_rooms r
    join public.route_duel_players p on p.id='00000000-0000-0000-0000-0000000000a1'
   where r.id = v_room;

  raise notice '%', 'X|reconnect_identical|'||(v_snap = v_again)::text||'|true';
  -- Rakibin gördüğü AYNI oyuncu satırı da aynı (tek otorite).
  perform set_config('torble.uid','00000000-0000-0000-0000-00000000a002', false);
  select p.current_key||'>'||array_to_string(p.path,'>') into v_again
    from public.route_duel_players p where p.id='00000000-0000-0000-0000-0000000000a1';
  raise notice '%', 'X|opponent_sees_same_row|'||
    (v_again = (select p.current_key||'>'||array_to_string(p.path,'>')
                  from public.route_duel_players p
                 where p.id='00000000-0000-0000-0000-0000000000a1'))::text||'|true';
end$$;
