-- ============================================================================
-- Kuşatma (Conquest) — Phase 9: RLS hardening
-- ============================================================================
-- AMAÇ
-- ----
-- Phase 5'te sevk edilen "using (true)" UPDATE/DELETE politikalarını
-- kaldırıp Kuşatma tablolarını gerçek RLS koruması altına alır. Misafir
-- katılım akışını bozmadan, yalnızca kimliği doğrulanabilir taraf yazma
-- yetkisi kazanır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_rooms / duel_group_players / duel_group_claims
--   • wheel_duel_rooms / wheel_duel_players
--   • wheel_group_rooms / wheel_group_players
--   • flag_duel_queue / wheel_duel_queue
--   • profiles, xp_events
--   • Var olan conquest_rooms / conquest_players SATIRLARI (backfill yok)
--   • supabase_realtime publication üyelikleri (conquest_rooms, conquest_players)
--
-- YENİ NESNELER
-- -------------
--   • public.conquest_player_claims    (INSERT-only, RLS açık, realtime DIŞI)
--   • public.conquest_authorize_player (helper)
--   • public.conquest_authorize_host   (helper)
--   • public.conquest_register_player  (RPC)
--   • public.conquest_update_player_color (RPC)
--   • public.conquest_leave_room       (RPC)
--   • public.conquest_apply_gameplay_state (RPC)
--
-- DEĞİŞEN POLİTİKALAR
-- -------------------
--   conquest_rooms:
--     SELECT  → herkes (eski davranış korunur, public liste için gerekli)
--     INSERT  → yalnız authenticated, host_profile_id = auth.uid()
--     UPDATE  → yalnız authenticated, host_profile_id = auth.uid()
--     DELETE  → yalnız authenticated, host_profile_id = auth.uid()
--   conquest_players:
--     SELECT  → herkes (lobi için gerekli)
--     INSERT  → kimlik tutarlılığı şart: profile_id = auth.uid() VEYA
--               (guest: profile_id NULL ve guest_id dolu)
--     UPDATE  → policy YOK → reddedilir; tek yol RPC
--     DELETE  → policy YOK → reddedilir; tek yol RPC
--
-- IDEMPOTENT
-- ----------
--   • Yeni tablo "if not exists" ile.
--   • Politikalar "drop policy if exists" sonrası "create policy".
--   • RPC'ler "create or replace function". İmzayı korur.
--
-- CANLI ODA ETKİSİ
-- ----------------
--   • Mevcut satırlara yazma/silme yapılmaz.
--   • Host (logged-in) yazma yetkisini aynen korur → mid-flight host akışı
--     bozulmaz.
--   • Migration öncesi katılmış misafirler claim_token sahibi DEĞİL → renk
--     güncelleme / leave RPC'leri "unauthorized" verir. Yeniden katılım
--     gerekir. Bu, güvenlik kazancı karşılığında bilinçli takastır.
--
-- TEHDİT MODELİ ÖZETİ
-- -------------------
--   • anon-key sahibi rastgele 3. parti artık başkasının odasını
--     silemez/kapatamaz, başka oyuncunun rengini değiştiremez, gameplay_state'i
--     üzerine yazamaz, host olmayan biri oda ayarlarını değiştiremez.
--   • Misafir kimliği localStorage'daki claim_token'a bağlı. Bu kanıt aynı
--     tarayıcı sekmesinde kalır; sekme değişirse kanıt kaybolur. JWT-less
--     misafir akışı için elimizdeki en sağlam tek-taraflı kanıt budur.
--   • Token DB'den asla SELECT'lenemez, realtime broadcast'e dahil edilmez,
--     URL'lere konulmaz → tarafımızdan sızdırılmaz.
--   • Misafir başına sınırsız kayıt veya oda doldurma gibi denial-of-service
--     vektörleri kapsam dışı; ileride INSERT'e trigger-tabanlı kapasite
--     kontrolü eklenebilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) conquest_player_claims  —  özel claim-token deposu
-- ----------------------------------------------------------------------------
-- Token'lar conquest_players ile aynı tabloda DURMAZ; eklenirse REPLICA
-- IDENTITY FULL nedeniyle realtime WAL akışında her aboneye gönderilirdi.
-- Ayrı tabloda tutarak (a) supabase_realtime publication üyesi yapmıyoruz,
-- (b) SELECT policy hiç eklemiyoruz → token sadece insert eden tarafta
-- bilinir.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.conquest_player_claims (
  player_id   uuid        primary key
                          references public.conquest_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);

alter table public.conquest_player_claims enable row level security;

-- INSERT açık (anon ve authenticated). Misafir bile join sırasında kendi
-- claim'ini bırakabilmeli. UPDATE/DELETE policy YOK → token rotate edilemez,
-- silinemez (player_id cascade ile silindiğinde otomatik temizlenir).
drop policy if exists "conquest_player_claims_insert" on public.conquest_player_claims;
create policy "conquest_player_claims_insert"
  on public.conquest_player_claims
  for insert
  to anon, authenticated
  with check (true);

-- Defense-in-depth: PostgREST yine de RLS'i uygular, ama SELECT için tablo
-- üstünde grant olmamasını da garanti altına al. (Supabase default tüm public
-- tablolarına anon+authenticated rolüne grant verir; biz select'i geri alıyoruz.)
revoke select, update, delete on public.conquest_player_claims from anon, authenticated;
grant insert on public.conquest_player_claims to anon, authenticated;

-- NOT: alter publication supabase_realtime ADD TABLE conquest_player_claims
-- ÇAĞRILMIYOR. Bu kasıtlı. Token asla broadcast edilmemeli.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Yetki yardımcıları (read-only, SECURITY DEFINER)
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bir player_id için: caller ya o satırın profile_id = auth.uid() sahibi
--     ya da claim_token eşleşen misafir mi?
create or replace function public.conquest_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.conquest_players p
      left join public.conquest_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            -- Logged-in: JWT subject == profile.
            (p.profile_id is not null and p.profile_id = auth.uid())
         or -- Misafir: claim_token eşleşmesi gereken yegane kanıt.
            (p_claim_token is not null and c.claim_token = p_claim_token)
       )
  );
$$;

revoke all on function public.conquest_authorize_player(uuid, uuid) from public;
grant execute on function public.conquest_authorize_player(uuid, uuid) to anon, authenticated;

-- (b) Verilen oda için: caller, oda host'unun ta kendisi mi?
create or replace function public.conquest_authorize_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.conquest_rooms r
     where r.id = p_room_id
       and r.host_player_id = p_player_id
       and public.conquest_authorize_player(p_player_id, p_claim_token)
  );
$$;

revoke all on function public.conquest_authorize_host(uuid, uuid, uuid) from public;
grant execute on function public.conquest_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Aksiyon RPC'leri (SECURITY DEFINER — manuel authz ardından RLS bypass)
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Atomik kayıt: oyuncu satırı + claim_token'ı tek transaction'da insert
--     eder ve oda updated_at'ini tazeler. Hem host (create) hem misafir
--     (join) bu RPC'yi çağırır. p_player_id NULL geçilirse rastgele üretilir
--     (misafir join); host create yolunda freshConquestPlayerId() üretilir
--     ve host_player_id ile aynı id geçirilir.
create or replace function public.conquest_register_player(
  p_room_id     uuid,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_color       text,
  p_is_host     boolean,
  p_claim_token uuid
) returns public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player public.conquest_players;
  v_uid    uuid := auth.uid();
  v_id     uuid := coalesce(p_player_id, gen_random_uuid());
begin
  -- Kimlik tutarlılığı
  if p_profile_id is not null then
    if v_uid is null or p_profile_id <> v_uid then
      raise exception 'profile_mismatch' using errcode = '42501';
    end if;
  else
    if p_guest_id is null or length(btrim(p_guest_id)) = 0 then
      raise exception 'guest_id_required' using errcode = '22023';
    end if;
  end if;

  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;

  -- Ad zorunlu (frontend zaten validate ediyor; defansif)
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  insert into public.conquest_players (
    id, room_id, profile_id, guest_id, name, is_host, color
  ) values (
    v_id, p_room_id, p_profile_id, p_guest_id, p_name, p_is_host, p_color
  )
  returning * into v_player;

  insert into public.conquest_player_claims (player_id, claim_token)
  values (v_player.id, p_claim_token);

  -- Public liste için tazelik sinyali. Trigger updated_at'i now()'a çekecek.
  update public.conquest_rooms set updated_at = now() where id = p_room_id;

  return v_player;
end;
$$;

revoke all on function public.conquest_register_player(uuid, uuid, uuid, text, text, text, boolean, uuid) from public;
grant execute on function public.conquest_register_player(uuid, uuid, uuid, text, text, text, boolean, uuid) to anon, authenticated;


-- (b) Renk güncellemesi. Kendi satırı + aynı odada renk çakışması yoksa
--     uygular. Çakışma → 'color_taken'; yetkisiz → 'unauthorized'.
create or replace function public.conquest_update_player_color(
  p_player_id   uuid,
  p_claim_token uuid,
  p_color       text
) returns public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player  public.conquest_players;
  v_room_id uuid;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select room_id into v_room_id
    from public.conquest_players
   where id = p_player_id;

  if v_room_id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  if p_color is not null and exists (
    select 1
      from public.conquest_players
     where room_id = v_room_id
       and id <> p_player_id
       and color = p_color
  ) then
    raise exception 'color_taken' using errcode = 'P0001';
  end if;

  update public.conquest_players
     set color = p_color
   where id = p_player_id
   returning * into v_player;

  return v_player;
end;
$$;

revoke all on function public.conquest_update_player_color(uuid, uuid, text) from public;
grant execute on function public.conquest_update_player_color(uuid, uuid, text) to anon, authenticated;


-- (c) Odadan ayrılma. Host ayrıldıysa odayı kapatır. Yanlış oda/silinmiş
--     oyuncu durumlarında sessizce no-op olur (idempotent leave).
create or replace function public.conquest_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_host boolean;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select is_host into v_is_host
    from public.conquest_players
   where id = p_player_id and room_id = p_room_id;

  if v_is_host is null then
    return; -- zaten yok / yanlış oda → no-op
  end if;

  delete from public.conquest_players where id = p_player_id;

  if v_is_host then
    update public.conquest_rooms
       set status      = 'closed',
           finished_at = now()
     where id = p_room_id;
  end if;
end;
$$;

revoke all on function public.conquest_leave_room(uuid, uuid, uuid) from public;
grant execute on function public.conquest_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- (d) Gameplay state apply. Oda 'playing' fazındaysa ve caller odaya ait bir
--     oyuncuysa (auth.uid() veya claim_token ile kanıtlanır) gameplay_state'i
--     yazar. Last-write-wins; ileride atomik transition kontrolü buraya
--     taşınabilir.
create or replace function public.conquest_apply_gameplay_state(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_state       jsonb
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conquest_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conquest_rooms
     where id = p_room_id and status = 'playing'
  ) then
    raise exception 'room_not_playing' using errcode = '42501';
  end if;

  if p_state is null then
    raise exception 'state_required' using errcode = '22023';
  end if;

  update public.conquest_rooms
     set gameplay_state = p_state
   where id = p_room_id;
end;
$$;

revoke all on function public.conquest_apply_gameplay_state(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.conquest_apply_gameplay_state(uuid, uuid, uuid, jsonb) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) conquest_rooms — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "conquest_rooms_select_all"  on public.conquest_rooms;
drop policy if exists "conquest_rooms_insert_anon" on public.conquest_rooms;
drop policy if exists "conquest_rooms_update_anon" on public.conquest_rooms;
drop policy if exists "conquest_rooms_delete_anon" on public.conquest_rooms;
-- yeni isim çakışmasını da temizle (idempotency)
drop policy if exists "conquest_rooms_insert_host" on public.conquest_rooms;
drop policy if exists "conquest_rooms_update_host" on public.conquest_rooms;
drop policy if exists "conquest_rooms_delete_host" on public.conquest_rooms;

create policy "conquest_rooms_select_all"
  on public.conquest_rooms
  for select
  to anon, authenticated
  using (true);

-- Oda kurma: yalnız logged-in kullanıcı, kendi auth.uid()'sini host olarak
-- yazabilir.
create policy "conquest_rooms_insert_host"
  on public.conquest_rooms
  for insert
  to authenticated
  with check (
    host_profile_id is not null
    and host_profile_id = auth.uid()
  );

-- Doğrudan UPDATE yetkisi sadece logged-in host'ta. Gameplay_state ve diğer
-- non-host yazımları SECURITY DEFINER RPC üzerinden bu policy'i bypass eder.
create policy "conquest_rooms_update_host"
  on public.conquest_rooms
  for update
  to authenticated
  using (host_profile_id is not null and host_profile_id = auth.uid())
  with check (host_profile_id is not null and host_profile_id = auth.uid());

-- Doğrudan DELETE yalnızca logged-in host: createConquestRoom rollback
-- yolu (host_player insert hatası) için gerekli.
create policy "conquest_rooms_delete_host"
  on public.conquest_rooms
  for delete
  to authenticated
  using (host_profile_id is not null and host_profile_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- 5) conquest_players — sıkılaştırılmış politikalar
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "conquest_players_select_all"  on public.conquest_players;
drop policy if exists "conquest_players_insert_anon" on public.conquest_players;
drop policy if exists "conquest_players_update_anon" on public.conquest_players;
drop policy if exists "conquest_players_delete_anon" on public.conquest_players;
-- yeni isim çakışmasını da temizle
drop policy if exists "conquest_players_insert_self" on public.conquest_players;

create policy "conquest_players_select_all"
  on public.conquest_players
  for select
  to anon, authenticated
  using (true);

-- Doğrudan INSERT yine açık (RPC tercih edilen yol; ama defansif RLS).
-- profile_id verilmişse auth.uid() ile eşleşmek ZORUNDA; misafir ise
-- guest_id dolu olmalı ve profile_id null kalmalı.
create policy "conquest_players_insert_self"
  on public.conquest_players
  for insert
  to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- KASITLI: UPDATE / DELETE policy YOK. Bu tablo üzerinde her yazma yolu
-- conquest_update_player_color veya conquest_leave_room RPC'sinden geçer.


-- ============================================================================
-- Doğrulama sorguları (manuel çalıştırılabilir):
--
--   -- Yeni tablo var mı?
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'conquest_player_claims';
--
--   -- Politikalar (eski "_anon" politikaları görünmemeli):
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename like 'conquest_%'
--    order by tablename, cmd;
--
--   -- conquest_player_claims realtime publication'da OLMAMALI:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename like 'conquest_%';
--   -- Beklenen: yalnızca conquest_rooms ve conquest_players listede olsun.
--
--   -- Fonksiyonlar:
--   select proname, prosecdef from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'conquest_%';
--
--   -- Negatif test: anon olarak başka bir oyuncunun rengini değiştirmeyi dene
--   --   (anon key ile): update conquest_players set color='red' where id='X';
--   -- → "new row violates row-level security policy" hatası bekleniyor.
-- ============================================================================
