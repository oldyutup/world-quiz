-- ============================================================================
-- Kör Nokta — AKTİF MAÇTAN AYRILMA (explicit leave) + takım yaşayabilirliği
-- ============================================================================
-- SORUN
-- ─────
-- Kör Nokta'nın TEK çıkış yolu `tevatur_leave_room` (20260711120000, en son
-- 20260810120000'de güncellendi) ve o fonksiyon oda DURUMUNU HİÇ SORMAZ:
-- lobide de, CANLI MAÇIN ortasında da yaptığı tek şey aynıdır — host'sa devret
-- ya da odayı sil, değilse kendi satırını sil.
--
-- Canlı bir 2v2'de bu şu demektir: oyuncu ayrılır, `tevatur_players` satırı
-- gider, ama `tevatur_rooms.status` 'playing' KALIR ve `game_state.teams` hâlâ
-- ayrılan oyuncunun id'sini taşır. Kalan üç oyuncunun maçı, bir takımı tek
-- kişiye düşmüş hâlde devam eder: o takımın dedektifi için raporcu kalmamıştır
-- (ya da dedektifin kendisi gitmiştir), turlar deadline'la boşa akar ve kimse
-- ne olduğunu anlamaz. Kimseye "oyuncu ayrıldı / maç bitti" DENMEZ.
--
-- ÇÖZÜM — DURUM-DUYARLI TEK GİRİŞ NOKTASI
-- ───────────────────────────────────────
-- Yeni `tevatur_kn_leave_match` çıkışın TEK istemci yolu olur ve kararı
-- SUNUCUDA oda durumundan türetir:
--
--   status <> 'playing'  → mevcut `tevatur_leave_room`a AYNEN devreder.
--                          Lobi çıkışı ve bitmiş maçtan çıkış BYTE-BYTE
--                          bugünküyle aynı kalır (host devri / oda silme /
--                          self-delete). Terminal maçtan çıkmak İKİNCİ bir
--                          terkediş ÜRETMEZ.
--
--   status =  'playing'  → GERÇEK TERK. Ayrılan oyuncu takımından düşülür,
--                          takım hâlâ oynanabilir mi diye SUNUCU bakar.
--
-- MİNİMUM YAŞAYABİLİR TAKIM = 2  (hardcode değil, oyunun kendi kuralı)
-- ─────────────────────────────────────────────────────────────────────
-- Her turda her takımda TAM BİR dedektif vardır (build_round,
-- 20260714123000: `detectiveOrder[team][roundIndex mod n]`) ve takımın geri
-- kalanı raporculardır. Bir takım tek kişiye düşerse o kişi zorunlu olarak
-- dedektiftir ve arkasında RAPORCU KALMAZ: `assignments` boşalır, dedektif
-- sıfır bilgiyle konum tahmin eder. Yani oyunun kendi rol dağılımı gereği bir
-- takımın oynayabilmesi için EN AZ 1 dedektif + 1 raporcu = 2 oyuncu gerekir.
-- `tevatur_kn_start_game` de zaten 4/6/8/10 oyuncu ve EŞİT takım şartı koyar
-- (2v2/3v3/4v4/5v5) — yani başlangıçtaki en küçük takım da 2'dir.
--
-- Sonuç: 2v2'de bir ayrılma maçı bitirir; 3v3'te bir ayrılma maçı BİTİRMEZ
-- (takım 2 kişiyle oynanabilir), ikinci ayrılma bitirir. Kural tek bir
-- fonksiyonda (`tevatur_kn_min_viable_team_size`) yaşar.
--
-- TERKEDİLMİŞ MAÇ GALİBİYET DEĞİLDİR
-- ──────────────────────────────────
-- Terminal durum `status='finished'` + `finished_reason='abandoned'`tır.
-- game_state.phase 'final_results'a ÇEKİLMEZ — ve XP'yi tetikleyen tam olarak
-- odur: KorNoktaGame yalnız `phase === "final_results"` görünce
-- `award_kornokta_xp_event` çağırır. Faz olduğu yerde bırakıldığı için
-- terkedilmiş maçtan XP, gold, galibiyet, kayıp ya da leaderboard istatistiği
-- ÜRETİLMEZ. Rakip takıma sahte galibiyet YAZILMAZ (winner kavramı bu yolda
-- hiç kullanılmaz).
--
-- İLERLEME DURUR: `tevatur_kn_advance_if_due` (20260813120000) 4. adımda
-- `status <> 'playing'` görünce DEĞİŞMEMİŞ odayı döndürür. Yani terminal maç
-- üzerinde faz ilerlemesi, puanlama ve tur artışı kendiliğinden imkânsızdır —
-- burada ekstra bir kilit gerekmez. `phaseEndsAt` ayrıca null'a çekilir ki
-- istemci sayaçları da sussun.
--
-- ODA SİLİNMEZ: terk dalında oda satırı ASLA silinmez (host ayrılsa ve geriye
-- yalnız misafir kalsa bile). Kalan oyuncuların terminal ekranı okuyabilmesi
-- için satırın yaşaması ŞARTTIR; host_player_id devredilemiyorsa null'a
-- düşer — bitmiş maçta host yetkisinin bir anlamı yoktur.
--
-- GÜVENLİK — mevcut modelin AYNISI, gevşetme YOK:
--   1. Kimlik  — `tevatur_authorize_player` (kayıtlı: JWT; misafir: claim
--                token). Misafir ve kayıtlı AYNI kurala tabidir.
--   2. Üyelik  — oyuncu satırı BU odada mı? Başka odadan alınmış geçerli bir
--                token başka bir maçı bitiremez (cross-room terk imkânsız).
--   3. Kilit   — `for update`; sonraki her okuma kanonik ve yarışsızdır.
--   4. Host farkı YOK — host da non-host da aynı yoldan geçer.
--
-- İSTEMCİDEN ALINMAYANLAR (kasıtlı): takım, oyuncu adı, kalan oyuncu sayısı,
-- "maçı bitir" bayrağı, terminal reason. İstemci YALNIZ "ben çıkıyorum" der;
-- maçın biteceğine SUNUCU karar verir.
--
-- ŞEMA DEĞİŞMEZ: yeni tablo/kolon/RLS/policy/trigger YOK. `finished_reason`
-- 20260711120000'den beri var ve bugüne dek Kör Nokta'da hiç yazılmamıştı.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_kn_min_viable_team_size — oyunun rol dağılımından türeyen eşik
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.tevatur_kn_min_viable_team_size()
returns int
language sql
immutable
as $$
  -- 1 dedektif + en az 1 raporcu. Bkz. dosya başlığı ve build_round
  -- (20260714123000): dedektif her turda takımdan TAM BİR kişidir, geri kalan
  -- herkes raporcudur. Tek kişilik takımda raporcu kalmaz.
  select 2;
$$;

revoke all     on function public.tevatur_kn_min_viable_team_size() from public;
grant  execute on function public.tevatur_kn_min_viable_team_size() to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_kn_leave_match — durum-duyarlı çıkış (TEK istemci yolu)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.tevatur_kn_leave_match(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.tevatur_rooms;
  v_state      jsonb;
  v_team       text;
  v_name       text;
  v_is_host    boolean;
  v_remaining  int;
  v_new_host   uuid;
begin
  -- 1) KİMLİK. Kayıtlıda auth.uid(), misafirde claim_token tek kanıttır.
  --    Hesabı silinmiş tombstone satırları iki dalın da dışında kalır.
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) KİLİT. Oda yoksa idempotent no-op (çift çağrı / yarış).
  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;
  end if;

  -- 3) ÜYELİK. Bu şart olmadan BAŞKA bir odadaki geçerli claim_token bu odanın
  --    maçını bitirebilirdi. Aynı zamanda çift çağrıyı da emer (ilk çağrı
  --    satırı sildiği için ikincisi buradan sessizce döner).
  select team, name into v_team, v_name
    from public.tevatur_players
   where id = p_player_id and room_id = p_room_id;
  if not found then
    return;
  end if;

  -- 4) MAÇ AKTİF DEĞİL → lobi/terminal çıkışı. Mevcut davranış AYNEN korunur;
  --    terkediş ÜRETİLMEZ. (Bitmiş maçtan "Ana Menüye Dön" buraya düşer.)
  if v_room.status <> 'playing' or v_room.game_state is null then
    perform public.tevatur_leave_room(p_room_id, p_player_id, p_claim_token);
    return;
  end if;

  -- ══════════════ 5) AKTİF MAÇTAN GERÇEK TERK ══════════════
  v_state   := v_room.game_state;
  v_is_host := (v_room.host_player_id = p_player_id);

  -- Takım kolonu boşsa (olmaması gerekir) game_state'ten türet — karar asla
  -- istemciden gelmez.
  if v_team is null then
    if v_state->'teams'->'blue' @> to_jsonb(p_player_id::text) then
      v_team := 'blue';
    elsif v_state->'teams'->'red' @> to_jsonb(p_player_id::text) then
      v_team := 'red';
    end if;
  end if;

  -- 5a) Oyuncu satırını sil — ayrılmak GERÇEKTEN ayrılmaktır.
  delete from public.tevatur_players
   where id = p_player_id and room_id = p_room_id;

  -- 5b) game_state'ten düş. Maç devam edecekse (3v3 → 2) bu ŞARTTIR: aksi
  --     hâlde rotasyon ayrılmış oyuncuyu dedektif seçmeye devam eder.
  if v_team is not null then
    v_state := jsonb_set(
      v_state, array['teams', v_team],
      coalesce((
        select jsonb_agg(e)
          from jsonb_array_elements_text(v_state->'teams'->v_team) e
         where e <> p_player_id::text
      ), '[]'::jsonb));

    if v_state ? 'detectiveOrder' then
      v_state := jsonb_set(
        v_state, array['detectiveOrder', v_team],
        coalesce((
          select jsonb_agg(e)
            from jsonb_array_elements_text(v_state->'detectiveOrder'->v_team) e
           where e <> p_player_id::text
        ), '[]'::jsonb));
    end if;
  end if;

  -- 5c) YAŞAYABİLİRLİK. Kalan sayı ODANIN GERÇEK satırlarından sayılır
  --     (game_state'ten değil) — tek doğruluk kaynağı budur.
  select count(*) into v_remaining
    from public.tevatur_players
   where room_id = p_room_id
     and team    = v_team;

  -- 5d) Host devri. Terk dalında oda ASLA silinmez; devralacak kayıtlı oyuncu
  --     yoksa host boşa düşer (bitmiş maçta host yetkisinin karşılığı yok).
  if v_is_host then
    select id into v_new_host
      from public.tevatur_players
     where room_id = p_room_id
       and id <> p_player_id
       and profile_id is not null
     order by joined_at asc
     limit 1;
  end if;

  if v_team is null or v_remaining < public.tevatur_kn_min_viable_team_size() then
    -- ── TAKIM OYNANAMAZ → MAÇ TERMİNAL ──
    -- phase'e DOKUNULMAZ: 'final_results' yazmak istemcide XP ödülünü
    -- tetiklerdi. phaseEndsAt null'a çekilir → istemci sayaçları durur;
    -- advance_if_due zaten status <> 'playing' gördüğü an no-op'a düşer.
    v_state := jsonb_set(v_state, '{phaseEndsAt}', 'null'::jsonb);
    v_state := jsonb_set(v_state, '{abandonedBy}', jsonb_build_object(
      'playerId', p_player_id,
      'name',     coalesce(v_name, 'Bir oyuncu'),
      'team',     v_team,
      'at',       public.tevatur_kn_now_ms()
    ));

    update public.tevatur_rooms
       set status          = 'finished',
           finished_at     = coalesce(finished_at, now()),
           finished_reason = 'abandoned',
           game_state      = v_state,
           host_player_id  = case when v_is_host then v_new_host else host_player_id end
     where id = p_room_id;
  else
    -- ── TAKIM HÂLÂ OYNANABİLİR → maç devam eder, state kırpılmış hâliyle ──
    update public.tevatur_rooms
       set game_state     = v_state,
           host_player_id = case when v_is_host then v_new_host else host_player_id end
     where id = p_room_id;
  end if;
end;
$$;

-- Misafir de kayıtlı da AYNI kurala tabidir → iki role de execute.
revoke all     on function public.tevatur_kn_leave_match(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_kn_leave_match(uuid, uuid, uuid) to anon;
grant  execute on function public.tevatur_kn_leave_match(uuid, uuid, uuid) to authenticated;


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Fonksiyonlar ve grant modeli:
--   select p.proname, p.prosecdef,
--          array(select r.rolname from pg_roles r
--                 where has_function_privilege(r.rolname, p.oid, 'execute')
--                   and r.rolname in ('anon','authenticated','public'))
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tevatur_kn_leave_match','tevatur_kn_min_viable_team_size');
--
-- B) Terkedilmiş maç XP üretmemeli — terk edilen odada xp_events OLMAMALI:
--   select count(*) from xp_events
--    where mode_key = 'kornokta' and room_id = '<ODA>';        -- 0 beklenir
--
-- C) Terminal maç ilerlememeli:
--   select status, finished_reason, game_state->>'phaseEndsAt'
--     from tevatur_rooms where id = '<ODA>';   -- finished / abandoned / null
-- ============================================================================
