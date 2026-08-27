-- ============================================================================
-- Rota Düello — OYUN İÇİ SÜRE KURALININ KALDIRILMASI
-- ============================================================================
-- ÜRÜN KARARI (2026-08-21)
-- ------------------------
-- Rota Düello'da OYUNCUYA DÖNÜK SÜRE SINIRI YOKTUR. Oyunun amacı zaten
-- "hedefe rakipten ÖNCE ulaşmak"; hız doğal olarak zaten belirleyici.
-- Ayrı bir geri sayım hiçbir kural katmıyordu, buna karşılık aktif maçı
-- kendiliğinden bitirebiliyordu.
--
-- Bu migration ÜÇ fonksiyonun GÖVDESİNİ değiştirir. Şema DEĞİŞMEZ, kolon
-- düşmez, hiçbir tablo/politika/grant'e dokunulmaz.
--
--   1) _route_duel_begin_round   → `round_deadline` artık OYUN KURALI DEĞİL
--   2) route_duel_submit_move    → 'expired' reddi KALKAR
--   3) route_duel_advance_round  → tur YALNIZ kazananla ilerler + settle guard
--
-- ────────────────────────────────────────────────────────────────────────────
-- NEDEN "MAÇ KENDİLİĞİNDEN BİTİYOR" İDİ (kök neden)
-- ────────────────────────────────────────────────────────────────────────────
-- Turun ilerleme kararı SUNUCUDA değil, İSTEMCİ SAATİNDE veriliyordu:
-- `route_duel_advance_round` "tur bitti mi?" sorusuna `now() >= round_deadline`
-- ile de EVET diyordu, ama ÇAĞRIYI ne zaman yapacağına istemci karar veriyor
-- ve o kararı `getSyncedNowMs()` + `new Date(round_deadline)` ile veriyordu.
--
-- Sonuç iki kırılma:
--   • Sunucu saat probe'u (`get_server_time_ms`) henüz çözülmemişse
--     `getSyncedNowMs()` SESSİZCE bare `Date.now()`a düşer (serverClock.ts).
--     Saati ileri giden cihaz turu erkenden "bitmiş" sayar.
--   • Kazanan yazıldığı ANDA sunucu tarafında hiçbir BEKLEME yoktu; tur-sonu
--     banner'ının 3.2 sn'si YALNIZCA istemcide tutuluyordu. Saati kaymış ya
--     da sadece hızlı davranan bir istemci `advance_round`u kazanan yazılır
--     yazılmaz çağırıp turu diğer oyuncunun ALTINDAN çekebiliyordu; rakip
--     sonucu hiç göremeden yeni tura düşüyordu ("PC aynı güncellemeyi
--     göstermiyor"). Turlar bu şekilde zincirlenince `current_round`
--     `total_rounds`a birkaç saniyede ulaşıyor ve skorlar farklıysa maç
--     FINALIZE oluyordu — sahadaki "10-15 saniyede maç bitiyor" tam olarak bu.
--
-- Bu migration ikisini birden kapatır: zamana dayalı ilerleme YOK EDİLİR ve
-- tur-sonu beklemesi SUNUCUYA taşınır (istemci artık pacing'in otoritesi
-- değil).
--
-- ────────────────────────────────────────────────────────────────────────────
-- ESKİ İSTEMCİ UYUMU — `round_deadline` NEDEN NULL YAPILMIYOR
-- ────────────────────────────────────────────────────────────────────────────
-- App Store/TestFlight'taki ESKİ paketler (≤ build 8) hamle gönderimini
-- `timeLeft > 0` ile kapılıyor ve `timeLeft`i `round_deadline`dan türetiyor.
-- Kolon NULL olsaydı o istemcilerde `timeLeft = 0` olur ve oyuncular HİÇBİR
-- hamle yapamazdı — sessiz, tam kırılma.
--
-- Bu yüzden kolon UZUN bir TEKNİK değerle doldurulur (6 saat). Bu bir geri
-- sayım DEĞİLDİR: sunucu artık ne submit'te ne advance'te bu değere BAKMAZ.
-- Yalnızca eski istemcilerin "süre var" görüp oynayabilmesi için durur.
-- Yeni istemci kolonu hiç okumaz (bkz. RouteDuelPlay.tsx — timer kaldırıldı).
--
-- ────────────────────────────────────────────────────────────────────────────
-- GEÇERLİ MAÇ BİTİŞLERİ (DEĞİŞMEDİ)
-- ────────────────────────────────────────────────────────────────────────────
--   • rota tamamlama → tur kazanılır → skor
--   • son tur + skorlar farklı → finalize (uzatma kuralı aynen)
--   • route_duel_leave_room  → forfeit
--   • route_duel_handle_disconnect → 20 sn SUNUCU guard'ı (oyun süresi değil,
--     bağlantı denetimi) — DOKUNULMADI.
--
-- IDEMPOTENT: yalnız `create or replace function`. DROP YOK → mevcut ACL
-- (grant/revoke) OLDUĞU GİBİ KORUNUR. Bu dosya BİLEREK hiçbir grant satırı
-- içermez: sonradan alınmış ACL kararlarını geri almamak için (bkz.
-- 20260815130000_final_acl_alignment.sql).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) _route_duel_begin_round — süre sınırı kurmaz
-- ----------------------------------------------------------------------------
-- ORİJİNALDEN TEK FARK: `round_deadline` artık 60 sn'lik oyun süresi değil,
-- eski istemciler için 6 saatlik teknik değer. Gövdenin geri kalanı (rota
-- seçimi, used_pair_keys birikimi, oyuncu konumlarının sıfırlanması) BİREBİR
-- aynıdır. `round_started_at` (3 sn ortak geri sayım) KORUNUR — o bir süre
-- sınırı değil, iki oyuncunun AYNI ANDA başlamasını sağlayan adalet
-- senkronudur; kaldırılırsa turu ilk gören oyuncu bedava başlangıç alır.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public._route_duel_begin_round(
  p_room_id    uuid,
  p_next_round int
) returns public.route_duel_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room   public.route_duel_rooms;
  v_pair   text;
  v_start  text;
  v_target text;
begin
  select * into v_room from public.route_duel_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  select o_pair_key, o_start_key, o_target_key
    into v_pair, v_start, v_target
    from public._route_duel_pick_route(v_room.used_pair_keys, v_room.route_length);

  -- NOT (ön-üretim incelemesinde doğrulandı): `v_pair` burada NULL OLAMAZ.
  -- `_route_duel_pick_route` ya bir satır döndürür (bant tükenirse TEKRARA
  -- izin veren fallback'i var) ya da 'route_pool_empty' fırlatır. En küçük
  -- bant 477 çift içeriyor. Bu yüzden `array_append(used, NULL)` tuzağı
  -- ERİŞİLEMEZ ve buraya koruma EKLENMEDİ — migration kapsamı dar tutuldu.
  -- (İleride pick_route "sessizce NULL dönebilir" hâle getirilirse dikkat:
  --  dizideki tek bir NULL `pair_key <> all(used)` ifadesini kalıcı olarak
  --  NULL/false yapar ve oda bir daha rota seçemez.)
  update public.route_duel_rooms
     set current_round          = p_next_round,
         round_start_key        = v_start,
         round_target_key       = v_target,
         round_pair_key         = v_pair,
         round_started_at       = now() + interval '3 seconds',
         -- OYUN KURALI DEĞİL — yalnız eski istemci uyumu (yukarıdaki nota bak).
         round_deadline         = now() + interval '6 hours',
         round_winner_player_id = null,
         round_decided_at       = null,
         used_pair_keys         = array_append(used_pair_keys, v_pair),
         updated_at             = now()
   where id = p_room_id
   returning * into v_room;

  update public.route_duel_players
     set current_key = v_start,
         path        = array[v_start]
   where room_id = p_room_id;

  return v_room;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) route_duel_submit_move — süre dolduğu için hamle REDDEDİLMEZ
-- ----------------------------------------------------------------------------
-- ORİJİNALDEN TEK FARK: `now() >= round_deadline → 'expired'` bloğu KALDIRILDI.
-- Diğer TÜM kurallar birebir korunur: yetki, oda kilidi (FOR UPDATE), tur
-- kararı guard'ı, geri sayım guard'ı, sunucudan okunan konum, graf komşuluk
-- doğrulaması, atomik ilk-bitiren claim'i (UNIQUE), skor ve tur kazananı.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.route_duel_submit_move(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_country_key text
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room      public.route_duel_rooms;
  v_player    public.route_duel_players;
  v_neighbors text[];
  v_new_path  text[];
  v_steps     int;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_key is null or length(btrim(p_country_key)) = 0 then
    raise exception 'country_key_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  if v_room.round_winner_player_id is not null then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'round_over');
  end if;
  if v_room.round_started_at is null or now() < v_room.round_started_at then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'not_started');
  end if;
  -- (KALDIRILDI) round_deadline aşımı → 'expired'.  Oyun içi süre sınırı yok.

  select * into v_player from public.route_duel_players
   where id = p_player_id and room_id = p_room_id;

  if v_player.current_key is null then
    raise exception 'round_not_initialized' using errcode = 'P0001';
  end if;
  if p_country_key = v_player.current_key then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'same_country');
  end if;

  select neighbors into v_neighbors
    from public.route_duel_graph
   where country_key = v_player.current_key;

  if v_neighbors is null or not (p_country_key = any(v_neighbors)) then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'not_neighbor');
  end if;

  v_new_path := array_append(v_player.path, p_country_key);
  v_steps    := coalesce(array_length(v_new_path, 1), 1) - 1;

  update public.route_duel_players
     set current_key  = p_country_key,
         path         = v_new_path,
         last_seen_at = now()
   where id = p_player_id;

  if p_country_key <> v_room.round_target_key then
    return jsonb_build_object(
      'accepted', true, 'finished', false, 'won', false,
      'current_key', p_country_key, 'steps', v_steps
    );
  end if;

  begin
    insert into public.route_duel_claims (room_id, player_id, game_seq, round, steps)
    values (p_room_id, p_player_id, v_room.game_seq, v_room.current_round, v_steps);
  exception
    when unique_violation then
      return jsonb_build_object('accepted', true, 'finished', true, 'won', false, 'reason', 'dup');
  end;

  update public.route_duel_players
     set score = score + 1
   where id = p_player_id;

  update public.route_duel_rooms
     set round_winner_player_id = p_player_id,
         round_decided_at       = now(),
         updated_at             = now()
   where id = p_room_id;

  return jsonb_build_object(
    'accepted', true, 'finished', true, 'won', true,
    'current_key', p_country_key, 'steps', v_steps
  );
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) route_duel_advance_round — tur YALNIZ kazananla ilerler
-- ----------------------------------------------------------------------------
-- ORİJİNALDEN İKİ FARK:
--
--   a) "Tur bitti mi?" artık SADECE `round_winner_player_id is not null`.
--      Zaman aşımıyla ilerleme YOK → geçen süre bir maçı ASLA bitiremez.
--      (Skoru değiştirmeyen "timeout turu" kavramı da böylece ortadan kalkar;
--      kimse hedefe ulaşmadıysa oyuncular oynamaya devam eder.)
--
--   b) SUNUCU-OTORİTER TUR-SONU BEKLEMESİ (settle guard): kazanan yazıldıktan
--      sonra 3.2 sn geçmeden HİÇBİR istemci turu ilerletemez.
--
--      OTORİTE KAYNAĞI: `route_duel_rooms.round_decided_at`. YENİ KOLON
--      EKLENMEDİ — bu damga zaten vardı ve kazananla AYNI transaction'da
--      sunucu `now()`u ile yazılıyor (submit_move), yani istemci onu ne
--      gönderebilir ne de etkileyebilir. Karşılaştırma da sunucuda `now()`
--      ile yapılır: istemci duvar saati denklemin HİÇBİR yerinde yok.
--
--      NEDEN ŞART: tur-sonu banner'ının 3.2 sn'si bugüne kadar YALNIZ
--      istemcide (ROUND_RESULT_MS) bekletiliyordu. Yeni istemciyi
--      "yalnız-kazanan" tetikleyiciye çevirmek YETMEZ: App Store/TestFlight'
--      taki ESKİ paketler (≤ build 8) kazananı görür görmez advance_round
--      çağırabiliyor ve turu rakibin altından çekebiliyordu. Guard sunucuda
--      olduğu için eski istemcinin erken çağrısı da 'round_not_over' alır ve
--      SESSİZCE no-op olur (eski istemci bu hatayı zaten yutuyor — bkz.
--      RouteDuelGame advance .then(): 'round_not_over' loglanmadan geçilir),
--      sonra kendi 400 ms'lik interval'inde yeniden dener → pencere dolunca
--      ilerletir. Yani eski istemci KIRILMAZ, sadece reveal'i atlayamaz.
--
--      Pencere dolduktan sonra İKİ istemci de ilerletebilir (host SPOF yok);
--      yarışan/çift çağrılar oda kilidi (FOR UPDATE) altında serileşir ve
--      ikincisi yeni turda 'round_not_over' alır → idempotent.
--      Bir istemci arka plana atılsa bile diğeri ilerletir → tur ASILI KALMAZ.
--
-- Finalize kuralı (son tur + farklı skor → kazanan = yüksek skor; eşitse
-- UZATMA) AYNEN korunur.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.route_duel_advance_round(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room      public.route_duel_rooms;
  v_hi        int;
  v_lo        int;
  v_winner_id uuid;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Tur YALNIZ kazananla biter. Süre aşımı yolu YOK.
  if v_room.round_winner_player_id is null then
    raise exception 'round_not_over' using errcode = 'P0001';
  end if;

  -- TUR-SONU REVEAL PENCERESİ — SUNUCU OTORİTESİ.
  -- `round_decided_at` kazananla aynı transaction'da sunucu now()'u ile
  -- yazıldı; karşılaştırma da sunucu now()'u. İstemci duvar saati YOK.
  -- Erken çağrı (yeni ya da ESKİ istemci fark etmez) 'round_not_over' alır;
  -- çağıran kendi interval'inde yeniden dener. Bu bir OYUN SÜRESİ DEĞİL,
  -- yalnız sonucun görülebildiği kısa reveal aralığıdır.
  if v_room.round_decided_at is not null
     and now() < v_room.round_decided_at + interval '3200 milliseconds' then
    raise exception 'round_not_over' using errcode = 'P0001';
  end if;

  select max(score), min(score) into v_hi, v_lo
    from public.route_duel_players
   where room_id = p_room_id;

  if v_room.current_round >= v_room.total_rounds and v_hi <> v_lo then
    select id into v_winner_id
      from public.route_duel_players
     where room_id = p_room_id
     order by score desc, joined_at asc
     limit 1;

    update public.route_duel_rooms
       set status           = 'finished',
           finished_at      = now(),
           finished_reason  = 'completed',
           winner_player_id = v_winner_id,
           updated_at       = now()
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;

    return v_room;
  end if;

  v_room := public._route_duel_begin_round(p_room_id, v_room.current_round + 1);
  return v_room;
end;
$$;
