-- ============================================================================
-- Flag Duel — flag_duel_leave_room · oda silmeden ÖNCE child satırları temizle
-- ============================================================================
-- SORUN (canlıda gözlendi, 2026-08-13 production smoke)
-- -----------------------------------------------------
-- 'waiting' bir Bayrak Düello odasında HOST çıktığında RPC patlıyordu:
--
--   update or delete on table "duel_rooms" violates foreign key constraint
--   "duel_players_room_id_fkey" on table "duel_players"
--
-- Sonuç: oda silinemiyor, host lobiden çıkınca 'waiting' bir ÖKSÜZ oda geride
-- kalıyor (oda listelerinde katılınabilir görünüyor).
--
-- KÖK NEDEN
-- ---------
-- 20260612120000 / 20260613120000'deki gövde "oda komple silinsin (FK cascade)"
-- yorumuyla doğrudan `delete from public.duel_rooms` yapıyor. Bu yorum YANLIŞ
-- bir varsayıma dayanıyor: `duel_players.room_id -> duel_rooms.id` FK'si
-- production'da ON DELETE CASCADE **DEĞİL**. `duel_rooms`/`duel_players`/
-- `duel_claims` legacy tablolardır (dashboard'da yaratıldılar, hiçbir migration
-- onları CREATE TABLE ile tanımlamaz) — dolayısıyla cascade davranışı hiçbir
-- zaman bu repo tarafından garanti edilmedi.
--
-- Aynı odada NON-HOST çıkışının çalışmasının sebebi: o dal önce kendi
-- `duel_players` satırını siliyor, oda ancak 0 oyuncu kalınca siliniyor.
-- Yani "önce child, sonra parent" deseni zaten kanıtlı — host dalında eksikti.
--
-- FK GRAFİĞİ (bu migration'ın dayandığı olgular)
-- ----------------------------------------------
--   duel_players.room_id       -> duel_rooms(id)     CASCADE YOK  ⚠ (hata kanıtı)
--   duel_player_claims.player_id -> duel_players(id) ON DELETE CASCADE
--                                   (20260603120000'de TANIMLI — okundu)
--   flag_duel_queue.matched_room_id      -> duel_rooms(id) ON DELETE SET NULL
--                                   (20260516130000'de TANIMLI — engellemez)
--   country_duel_queue.matched_room_id   -> duel_rooms(id) ON DELETE SET NULL
--                                   (20260701120000'de TANIMLI — engellemez)
--   duel_claims.room_id        -> duel_rooms(id)     davranışı BİLİNMİYOR
--                                   (legacy tablo) → savunma amaçlı elle silinir
--   duel_messages              -> FK YOK; `room_code` ile eşleşir, DOKUNULMAZ
--
-- ÇÖZÜM (seçilen: A — RPC içinde açık child cleanup)
-- --------------------------------------------------
-- FK'yi ON DELETE CASCADE'e ÇEVİRMEDİK. Gerekçe: `duel_rooms`/`duel_players`
-- Bayrak Düello'ya AİT DEĞİL — Ülke Yaz Düello (duel_*), Çark Düello
-- (wheel_duel_*), Çark Grup ve Bayrak QM akışları da AYNI iki tabloyu
-- paylaşıyor. FK davranışını değiştirmek bu modların hepsinin silme
-- semantiğini tek hamlede değiştirir (ör. bugün FK ihlaliyle KORUNAN bir
-- yanlış silme sessizce tüm oyuncu satırlarını süpürmeye başlayabilir).
-- Bu migration'ın kapsamı TEK bir RPC gövdesi; şema/constraint DEĞİŞMİYOR.
--
-- DEĞİŞEN TEK ŞEY: host 'waiting' dalında oda silinmeden önce child satırlar
-- doğru FK sırasıyla ve YALNIZ p_room_id kapsamında siliniyor. Sıra:
--   1. duel_claims  (room_id = p_room_id)   ← 'waiting' odada bugün HEP 0 satır
--   2. duel_players (room_id = p_room_id)   ← duel_player_claims cascade ile gider
--   3. duel_rooms   (id = p_room_id)
--
-- 1. adım bugün ispatlanabilir biçimde NO-OP'tur: claim yalnız 'playing'
-- odada yazılır (`flag_duel_submit_claim` status='playing' şartı) ve
-- `flag_duel_accept_rematch` claim'leri silip odayı DOĞRUDAN 'playing' yapar —
-- yani 'waiting' + claim durumu erişilebilir değil. Savunma amaçlı duruyor ki
-- "oda silinirken child kalmaz" değişmezi gövdenin kendisinden okunabilsin.
--
-- DEĞİŞMEYEN DAVRANIŞLAR (bilinçli — hepsi aynen korundu)
-- -------------------------------------------------------
--   • unauthorized (flag_duel_authorize_player)                       → 42501
--   • player_room_mismatch                                            → 42501
--   • oda yok / status='finished'                                     → no-op
--   • status='playing' → forfeit (finished + winner = rakip)          → AYNEN
--   • non-host 'waiting' → yalnız kendi satırı, oda boşalınca oda      → AYNEN
--   • host tespiti flag_duel_authorize_host ile                        → AYNEN
--   • imza, dönüş tipi, SECURITY DEFINER, search_path, GRANT modeli    → AYNEN
--
-- DOKUNULMAYANLAR
-- ---------------
--   • duel_leave_room (Ülke Yaz Düello) — AYNI hatayı taşıyor (satır ~1015,
--     "FK cascade ile players + player_claims" yorumu aynı yanlış varsayım).
--     Bu migration'ın kapsamı DIŞINDA bırakıldı: ayrı mod, ayrı RPC, ayrı
--     doğrulama gerekir. Ayrıntı için rapora bakın.
--   • duel_players / duel_rooms / duel_claims şeması ve constraint'leri
--   • Diğer tüm flag_duel_* RPC'leri
--   • Quick Match akışı: QM odalarında host_player_id NULL'dır; host tespiti
--     flag_duel_authorize_host'un "en eski joined_at" dalından gelir ve bu
--     migration o mantığa DOKUNMAZ.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- flag_duel_leave_room — faz duyarlı çıkış (child cleanup düzeltmesiyle)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.duel_rooms;
  v_is_host   boolean;
  v_opp_id    uuid;
  v_remaining int;
begin
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → no-op
  end if;
  if v_room.status = 'finished' then
    return;  -- zaten kapanmış → no-op
  end if;

  -- Player odaya gerçekten ait mi?
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Playing → forfeit yolu (DEĞİŞMEDİ)
  if v_room.status = 'playing' then
    select id into v_opp_id
      from public.duel_players
     where room_id = p_room_id and id <> p_player_id
     limit 1;

    update public.duel_rooms
       set status              = 'finished',
           finished_reason     = 'forfeit',
           forfeited_player_id = p_player_id,
           winner_player_id    = v_opp_id
     where id = p_room_id
       and status = 'playing';
    return;
  end if;

  -- Waiting yolu: host mu?
  v_is_host := public.flag_duel_authorize_host(p_room_id, p_player_id, p_claim_token);

  if v_is_host then
    -- Host ayrılıyor → oda komple silinsin.
    --
    -- DÜZELTME: `duel_players.room_id` FK'si ON DELETE CASCADE DEĞİL, bu yüzden
    -- doğrudan room delete FK ihlaliyle patlıyordu. Child satırlar YALNIZ bu
    -- odanın kapsamında (room_id = p_room_id) ve doğru FK sırasıyla silinir.
    -- Tüm gövde tek transaction olduğu için ya hepsi olur ya hiçbiri.
    delete from public.duel_claims  where room_id = p_room_id;
    delete from public.duel_players where room_id = p_room_id;
    delete from public.duel_rooms   where id = p_room_id;
    return;
  end if;

  -- Non-host waiting → kendi player satırı (DEĞİŞMEDİ)
  delete from public.duel_players
   where id = p_player_id and room_id = p_room_id;

  -- Oda boşaldıysa cleanup. Aynı değişmez: parent'tan önce child.
  select count(*) into v_remaining
    from public.duel_players where room_id = p_room_id;
  if v_remaining = 0 then
    delete from public.duel_claims where room_id = p_room_id;
    delete from public.duel_rooms  where id = p_room_id;
  end if;
end;
$$;

-- ACL — AÇIK ve KASITLI, varsayılana GÜVENİLMEZ.
-- `create or replace` mevcut grant'leri korur, ama Supabase'de public şemadaki
-- fonksiyonlar anon'a DOĞRUDAN EXECUTE ile doğduğu için grant modeli her
-- migration'da açıkça yeniden yazılır (bkz. 20260809130000 hotfix'i).
-- anon EXECUTE İSTENEN durumdur: Bayrak Düello'ya misafir katılabilir ve
-- kendi odasından çıkabilmelidir; yetki reddini gövdedeki
-- flag_duel_authorize_player / flag_duel_authorize_host yapar.
revoke all     on function public.flag_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.flag_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
