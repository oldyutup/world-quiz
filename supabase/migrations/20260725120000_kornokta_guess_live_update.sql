-- ============================================================================
-- Kör Nokta — konum tahmini CANLI güncellenebilir (pin kilidi kaldırıldı)
-- ============================================================================
-- Amaç: detective_guess fazı boyunca (35 sn) dedektif haritada istediği kadar
-- farklı noktaya tıklayabilsin; her tıklama o takımın ADAY koordinatını
-- güncellesin. Süre dolunca (host-authoritative advance_phase → apply_round)
-- game_state.guesses altında KAYITLI olan EN SON konum nihai tahmin sayılır.
--
-- ÖNCE (20260724120000): submit_guess ilk tahminden sonra 'already_submitted'
-- ile ikinci yazıyı REDDEDİYORDU (tek-atış). Client ilk pinden sonra haritayı
-- kilitleyip "Süre Bekleniyor" gösteriyordu. Kullanıcı tahminini değiştiremiyordu.
--
-- SONRA (bu migration): submit_guess AYNI takımın tahminini faz açıkken
-- DEFALARCA günceller. Değişiklikler:
--   1) 'already_submitted' tek-atış reddi KALDIRILDI. Aynı takım kendi aday
--      koordinatını üzerine yazabilir.
--   2) LATEST-WRITE-WINS: her tahmin, client'ın verdiği monotonik `p_seq`
--      (strictly increasing, Date.now() tabanlı) ile birlikte `seq` alanında
--      saklanır. Gelen istek, kayıtlı seq'ten KÜÇÜK/EŞİTse (ağdan geç gelen /
--      sıra bozulmuş eski tık) SESSİZCE yok sayılır (no-op, güncel oda döner) →
--      eski istek yeni konumu EZEMEZ.
--   3) DEADLINE OTORİTESİ (SERT/KESİN): server phaseEndsAt otoriter cutoff'tur.
--      Server zamanı phaseEndsAt'ı GEÇTİYSE yeni konum güncellemesi HER ZAMAN
--      'guess_deadline_passed' ile reddedilir. Ağ-gecikme toleransı YOKTUR →
--      konum tahmini kullanıcı açısından gerçekten 35 sn'dir (0'dan sonra kabul
--      edilen ek süre yok). Deadline'dan ÖNCE yazılmış son geçerli koordinat
--      apply_round'da nihai tahmin sayılır.
--   4) Faz İLERLETMEZ / skor HESAPLAMAZ: yalnız guesses[team] yazar. Erken geçiş
--      (iki dedektif de gönderdi → round_reveal) 20260724120000'da kaldırılmıştı;
--      GERİ GELMEZ. round_reveal'e TEK yol süre dolunca advance_phase → apply_round.
--
-- İMZA: sonuna `p_seq bigint` eklenerek 6 parametreli ANA (latest-write-wins)
-- sürüm oluşturulur. Eski 5 parametreli imza DROP EDİLMEZ; kısa geçiş döneminde
-- eski client'lar hata almasın diye UYUMLULUK WRAPPER'ına dönüştürülür (aşağıda).
-- Yeni client `p_seq` gönderdiği için PostgREST 6 parametreli sürümü seçer; eski
-- client `p_seq` göndermez → 5 parametreli wrapper çalışır.
--
-- DOKUNULMAYANLAR (bilinçli):
--   • answer_questions erken tamamlama, 35 sn tek-kaynak (phase_duration_ms),
--     advance_phase, apply_round, phaseEndsAt kurulumu, host timer + FOR UPDATE
--     satır kilidi, iki takımın bağımsızlığı AYNI.
--   • apply_round guesses[team]->>'lat'/'lng' okur; eklenen `seq` alanı map_result
--     tarafından yok sayılır → skor hesabı etkilenmez.
--   • İki takım guesses.blue / guesses.red ayrı slotlara yazar → bağımsız güncellenir.
-- ============================================================================

-- ── ANA sürüm: 6 parametreli (p_seq) latest-write-wins ──────────────────────
create or replace function public.tevatur_kn_submit_guess(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_lat         double precision,
  p_lng         double precision,
  p_seq         bigint
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
  v_team     text;
  v_lng      double precision;
  v_guess    jsonb;
  v_existing jsonb;
  v_prev_seq bigint;
  v_deadline bigint;
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

  if v_round->'detectives'->>'blue' = v_pid then
    v_team := 'blue';
  elsif v_round->'detectives'->>'red' = v_pid then
    v_team := 'red';
  else
    raise exception 'not_detective' using errcode = 'P0001';
  end if;

  -- DEADLINE OTORİTESİ (SERT): server phaseEndsAt geçtiyse yeni konum yazma;
  -- tolerans YOK. Böylece süre kullanıcı açısından tam 35 sn'dir. Nihai konum
  -- deadline'dan önce yazılmış son kayıttır (apply_round onu okur).
  v_deadline := (v_state->>'phaseEndsAt')::bigint;
  if v_deadline is not null
     and public.tevatur_kn_now_ms() > v_deadline then
    raise exception 'guess_deadline_passed' using errcode = 'P0001';
  end if;

  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90
     or p_lng not between -100000 and 100000 then
    raise exception 'guess_required' using errcode = '22023';
  end if;
  -- worldCopyJump pan'i ±180 dışına taşıyabilir → normalize et.
  v_lng := ((p_lng + 180.0) - 360.0 * floor((p_lng + 180.0) / 360.0)) - 180.0;

  -- LATEST-WRITE-WINS: bu takımın kayıtlı seq'inden küçük/eşit gelen istek
  -- (ağdan geç gelen / sıra bozulmuş eski tık) yeni konumu EZMESİN. Sessizce
  -- yok say (no-op) ve güncel odayı döndür → hata gösterme, retry gerekmez.
  -- Migration ÖNCESİNDEN kalmış {lat,lng} (seq'siz) kayıtta ->>'seq' NULL döner →
  -- (NULL)::bigint = NULL → coalesce ile 0 kabul edilir (cast/null hatası yok).
  v_existing := v_round->'guesses'->v_team;
  if jsonb_typeof(v_existing) = 'object' then
    v_prev_seq := coalesce((v_existing->>'seq')::bigint, 0);
    if p_seq is not null and p_seq <= v_prev_seq then
      return v_room;
    end if;
  end if;

  v_guess := jsonb_build_object('lat', p_lat, 'lng', v_lng, 'seq', coalesce(p_seq, 0));
  v_round := jsonb_set(v_round, array['guesses', v_team], v_guess);
  v_state := jsonb_set(v_state, array['rounds', v_idx::text], v_round);

  -- NOT: Faz BURADA ilerlemez, skor hesaplanmaz. Yalnız aday koordinat yazılır.
  -- round_reveal'e geçiş TEK yoldan: süre dolunca advance_phase → apply_round.

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision, bigint) from public;
grant execute on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision, bigint) to authenticated;

-- ── UYUMLULUK WRAPPER: 5 parametreli (p_seq'siz), eski client'lar için ──────
-- Eski 5 parametreli imza DROP EDİLMEZ; bunun yerine 6 parametreli ana sürüme
-- YÖNLENDİREN ince bir wrapper'a dönüştürülür (create or replace). Böylece kısa
-- geçiş döneminde henüz güncellenmemiş eski client'lar hata almaz.
--
-- seq = 0 ile yönlendirir: eski client tek-atış bir tahmin gönderir (kilit sonrası
-- güncellemez). p_seq=0, ana fonksiyonun latest-write-wins kontrolünde daima
-- mevcut new-client seq'inden (Date.now() ~1.7e12) küçük/eşit sayılır → eski
-- client'ın yazısı, yeni client'ın DAHA YENİ konum güncellemesini EZEMEZ. Slot
-- boşsa (mevcut tahmin yok) normal yazılır (ilk/tek tahmin kaydedilir).
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
begin
  return public.tevatur_kn_submit_guess(
    p_room_id, p_player_id, p_claim_token, p_lat, p_lng, 0::bigint
  );
end;
$$;

revoke all on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) from public;
grant execute on function public.tevatur_kn_submit_guess(uuid, uuid, uuid, double precision, double precision) to authenticated;

-- PostgREST/Supabase RPC schema cache'i yeni 6 parametreli imzayı HEMEN görsün.
notify pgrst, 'reload schema';

-- ============================================================================
-- DONE — detective_guess artık canlı güncellenebilir. Aynı takım faz açıkken
-- tahminini defalarca değiştirir; monotonik seq ile latest-write-wins (eski/geç
-- istek ezemez); SERT deadline sonrası reddedilir (tolerans yok, tam 35 sn);
-- faz erken kapanmaz (round_reveal'e yalnız süre dolunca advance_phase →
-- apply_round ile geçilir). 6 parametreli ana sürüm + 5 parametreli uyumluluk
-- wrapper'ı (seq=0) birlikte yaşar; PostgREST p_seq varlığına göre doğru overload'ı
-- seçer. apply_round / answer erken tamamlama / 35 sn tek kaynak / iki takım
-- bağımsızlığı değişmedi.
-- ============================================================================
