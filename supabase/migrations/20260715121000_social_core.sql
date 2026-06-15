-- ============================================================================
-- Sosyal Çekirdek (V1): Arkadaşlık + Bildirim + Kozmetik + Block
-- ============================================================================
-- Amac:
--   Public profil kartı, arkadaşlık isteği, oyun/lobi daveti ve ortak bildirim
--   merkezi için ortak veri modeli. Tüm yazma yolları auth.uid() kullanan
--   SECURITY DEFINER RPC'lerden geçer; client başka kullanıcı adına bildirim
--   üretemez. RLS yalnızca okuma (self / public showcase) ve kozmetik self-write
--   verir.
--
-- Tablolar:
--   friend_requests, friends, notifications, profile_cosmetics, blocked_profiles
--
-- RPC'ler (hepsi SECURITY DEFINER, actor = auth.uid()):
--   send_friend_request, respond_friend_request, send_room_invite,
--   mark_notification_read, mark_all_notifications_read,
--   get_public_profile, get_public_profiles
--
-- GÜVENLİK:
--   * notifications: SELECT yalnız recipient = auth.uid(); INSERT/UPDATE policy
--     YOK → client yazamaz; okundu işaretleme RPC'den (definer) geçer.
--   * friend_requests / friends / blocked_profiles: SELECT taraf olan kullanıcı;
--     yazma policy YOK → yalnız RPC.
--   * profile_cosmetics: SELECT herkes (public showcase); INSERT/UPDATE yalnız
--     profile_id = auth.uid() (kendi kozmetiğini yazar). Paid ownership: TODO.
--
-- TODO (bu fazda DEĞİL):
--   * Block filtreleme (engellenenden friend request / invite gelmesin).
--   * Paid cosmetic ownership kontrolü.
--   * Push notification (profile_push_tokens).
--
-- Idempotent + elle uygulanır. Bağımlılık: profiles, xp_events.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) TABLOLAR
-- ----------------------------------------------------------------------------

create table if not exists public.friend_requests (
  id                   uuid        primary key default gen_random_uuid(),
  requester_profile_id uuid        not null references public.profiles(id) on delete cascade,
  recipient_profile_id uuid        not null references public.profiles(id) on delete cascade,
  status               text        not null default 'pending'
                                     check (status in ('pending','accepted','rejected','cancelled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (requester_profile_id <> recipient_profile_id)
);

-- Aynı yönde tek açık (pending) istek — tekrar tekrar pending engeli.
create unique index if not exists friend_requests_one_pending_uniq
  on public.friend_requests (requester_profile_id, recipient_profile_id)
  where status = 'pending';

create index if not exists friend_requests_recipient_idx
  on public.friend_requests (recipient_profile_id, status);
create index if not exists friend_requests_requester_idx
  on public.friend_requests (requester_profile_id, status);

create table if not exists public.friends (
  profile_id        uuid        not null references public.profiles(id) on delete cascade,
  friend_profile_id uuid        not null references public.profiles(id) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (profile_id, friend_profile_id)
);

create table if not exists public.notifications (
  id                   uuid        primary key default gen_random_uuid(),
  recipient_profile_id uuid        not null references public.profiles(id) on delete cascade,
  actor_profile_id     uuid        null references public.profiles(id) on delete set null,
  type                 text        not null,
  title                text        not null,
  body                 text        null,
  payload              jsonb       not null default '{}'::jsonb,
  read_at              timestamptz null,
  created_at           timestamptz not null default now()
);

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_profile_id, created_at desc);
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_profile_id)
  where read_at is null;

create table if not exists public.profile_cosmetics (
  profile_id               uuid        primary key references public.profiles(id) on delete cascade,
  showcased_badge_ids      text[]      not null default '{}',
  active_avatar_frame_id   text        null,
  active_profile_theme_id  text        null,
  active_name_color_id     text        null,
  active_profile_card_style_id text    null,
  updated_at               timestamptz not null default now()
);

create table if not exists public.blocked_profiles (
  blocker_profile_id uuid        not null references public.profiles(id) on delete cascade,
  blocked_profile_id uuid        not null references public.profiles(id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (blocker_profile_id, blocked_profile_id)
);

-- ----------------------------------------------------------------------------
-- 2) RLS
-- ----------------------------------------------------------------------------

alter table public.friend_requests   enable row level security;
alter table public.friends           enable row level security;
alter table public.notifications     enable row level security;
alter table public.profile_cosmetics enable row level security;
alter table public.blocked_profiles  enable row level security;

-- friend_requests: taraf olan kullanıcı okuyabilir. Yazma yok → RPC.
drop policy if exists "friend_requests_select_party" on public.friend_requests;
create policy "friend_requests_select_party"
  on public.friend_requests for select
  to authenticated
  using (requester_profile_id = auth.uid() or recipient_profile_id = auth.uid());

-- friends: kendi arkadaş satırlarını okuyabilir. Yazma yok → RPC.
drop policy if exists "friends_select_self" on public.friends;
create policy "friends_select_self"
  on public.friends for select
  to authenticated
  using (profile_id = auth.uid() or friend_profile_id = auth.uid());

-- notifications: yalnız alıcı okuyabilir. INSERT/UPDATE policy YOK → RPC.
drop policy if exists "notifications_select_self" on public.notifications;
create policy "notifications_select_self"
  on public.notifications for select
  to authenticated
  using (recipient_profile_id = auth.uid());

-- profile_cosmetics: showcase herkese açık; yalnız sahibi yazar.
drop policy if exists "profile_cosmetics_select_public" on public.profile_cosmetics;
create policy "profile_cosmetics_select_public"
  on public.profile_cosmetics for select
  to anon, authenticated
  using (true);

drop policy if exists "profile_cosmetics_insert_self" on public.profile_cosmetics;
create policy "profile_cosmetics_insert_self"
  on public.profile_cosmetics for insert
  to authenticated
  with check (profile_id = auth.uid());

drop policy if exists "profile_cosmetics_update_self" on public.profile_cosmetics;
create policy "profile_cosmetics_update_self"
  on public.profile_cosmetics for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- blocked_profiles: yalnız blocker okuyabilir. Yazma: TODO (RPC ileride).
drop policy if exists "blocked_profiles_select_self" on public.blocked_profiles;
create policy "blocked_profiles_select_self"
  on public.blocked_profiles for select
  to authenticated
  using (blocker_profile_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3) Yardımcı: kullanıcının genel level'i (leaderboard ile aynı formül)
-- ----------------------------------------------------------------------------
create or replace function public._social_level(p_profile_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $fn$
  select (floor(sqrt(coalesce(sum(e.xp_earned), 0) / 100.0))::int + 1)
    from public.xp_events e
   where e.profile_id = p_profile_id;
$fn$;

-- ----------------------------------------------------------------------------
-- 4) RPC: send_friend_request
-- ----------------------------------------------------------------------------
create or replace function public.send_friend_request(p_recipient uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me        uuid := auth.uid();
  v_me_uname  text;
  v_req_id    uuid;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_recipient is null then
    raise exception 'recipient_required' using errcode = '22023';
  end if;
  if p_recipient = v_me then
    raise exception 'cannot_friend_self' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_recipient) then
    raise exception 'recipient_not_found' using errcode = 'P0001';
  end if;

  -- TODO(block): blocked_profiles kontrolü (iki yön) ileride buraya.

  if exists (
    select 1 from public.friends
     where profile_id = v_me and friend_profile_id = p_recipient
  ) then
    raise exception 'already_friends' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.friend_requests
     where requester_profile_id = v_me
       and recipient_profile_id = p_recipient
       and status = 'pending'
  ) then
    raise exception 'request_already_sent' using errcode = 'P0001';
  end if;

  -- Karşı taraf zaten bana pending istek attıysa: çift istek üretme, bilgi ver.
  if exists (
    select 1 from public.friend_requests
     where requester_profile_id = p_recipient
       and recipient_profile_id = v_me
       and status = 'pending'
  ) then
    raise exception 'incoming_request_exists' using errcode = 'P0001';
  end if;

  select username into v_me_uname from public.profiles where id = v_me;

  insert into public.friend_requests (requester_profile_id, recipient_profile_id, status)
  values (v_me, p_recipient, 'pending')
  returning id into v_req_id;

  insert into public.notifications (recipient_profile_id, actor_profile_id, type, title, body, payload)
  values (
    p_recipient, v_me, 'friend_request', 'Arkadaşlık isteği',
    '@' || coalesce(v_me_uname, 'biri') || ' sana arkadaşlık isteği gönderdi.',
    jsonb_build_object('friendRequestId', v_req_id, 'actorUsername', v_me_uname)
  );

  return jsonb_build_object('ok', true, 'friendRequestId', v_req_id);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 5) RPC: respond_friend_request
-- ----------------------------------------------------------------------------
create or replace function public.respond_friend_request(p_request_id uuid, p_response text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me       uuid := auth.uid();
  v_req      public.friend_requests;
  v_me_uname text;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_response not in ('accepted','rejected') then
    raise exception 'invalid_response' using errcode = '22023';
  end if;

  select * into v_req from public.friend_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if v_req.recipient_profile_id <> v_me then
    raise exception 'not_your_request' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request_not_pending' using errcode = 'P0001';
  end if;

  update public.friend_requests
     set status = p_response, updated_at = now()
   where id = p_request_id;

  if p_response = 'accepted' then
    -- Çift yönlü arkadaşlık satırı (idempotent).
    insert into public.friends (profile_id, friend_profile_id)
    values (v_req.requester_profile_id, v_req.recipient_profile_id)
    on conflict do nothing;
    insert into public.friends (profile_id, friend_profile_id)
    values (v_req.recipient_profile_id, v_req.requester_profile_id)
    on conflict do nothing;

    select username into v_me_uname from public.profiles where id = v_me;

    -- Gönderene "kabul edildi" bildirimi.
    insert into public.notifications (recipient_profile_id, actor_profile_id, type, title, body, payload)
    values (
      v_req.requester_profile_id, v_me, 'friend_request_accepted', 'Arkadaşlık isteği kabul edildi',
      '@' || coalesce(v_me_uname, 'biri') || ' arkadaşlık isteğini kabul etti.',
      jsonb_build_object('friendProfileId', v_me, 'actorUsername', v_me_uname)
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_response);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) RPC: send_room_invite
-- ----------------------------------------------------------------------------
create or replace function public.send_room_invite(
  p_recipient uuid,
  p_room_code text,
  p_mode      text,
  p_room_url  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me       uuid := auth.uid();
  v_me_uname text;
  v_notif_id uuid;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_recipient is null or p_room_code is null or length(btrim(p_room_code)) = 0 then
    raise exception 'invite_args_required' using errcode = '22023';
  end if;
  if p_recipient = v_me then
    raise exception 'cannot_invite_self' using errcode = 'P0001';
  end if;

  -- TODO(block): blocked_profiles kontrolü ileride.

  -- Spam guard: aynı alıcıya aynı oda için son 60sn'de davet varsa tekrar üretme.
  if exists (
    select 1 from public.notifications
     where recipient_profile_id = p_recipient
       and actor_profile_id = v_me
       and type = 'room_invite'
       and payload->>'roomCode' = p_room_code
       and created_at > now() - interval '60 seconds'
  ) then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  select username into v_me_uname from public.profiles where id = v_me;

  insert into public.notifications (recipient_profile_id, actor_profile_id, type, title, body, payload)
  values (
    p_recipient, v_me, 'room_invite', 'Oyun daveti',
    '@' || coalesce(v_me_uname, 'biri') || ' seni bir oyuna davet etti.',
    jsonb_build_object('roomCode', p_room_code, 'mode', p_mode, 'roomUrl', p_room_url)
  )
  returning id into v_notif_id;

  return jsonb_build_object('ok', true, 'notificationId', v_notif_id);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 7) RPC: mark_notification_read / mark_all_notifications_read
-- ----------------------------------------------------------------------------
create or replace function public.mark_notification_read(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where id = p_id
     and recipient_profile_id = v_me
     and read_at is null;
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function public.mark_all_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where recipient_profile_id = v_me
     and read_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'updated', v_n);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 8) RPC: get_public_profile (tekil) — profil kartı için
--    Gold DÖNDÜRMEZ. relationship_status caller'a (auth.uid()) göre hesaplanır.
-- ----------------------------------------------------------------------------
create or replace function public.get_public_profile(p_profile_id uuid)
returns table (
  profile_id          uuid,
  username            text,
  avatar_id           text,
  level               int,
  showcased_badge_ids text[],
  active_avatar_frame_id  text,
  active_profile_theme_id text,
  active_name_color_id    text,
  relationship_status text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    coalesce(c.showcased_badge_ids, '{}'::text[]),
    c.active_avatar_frame_id,
    c.active_profile_theme_id,
    c.active_name_color_id,
    case
      when v_me is null then 'none'
      when p.id = v_me then 'self'
      when exists (
        select 1 from public.friends f
         where f.profile_id = v_me and f.friend_profile_id = p.id
      ) then 'friends'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = v_me and r.recipient_profile_id = p.id
           and r.status = 'pending'
      ) then 'request_sent'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = p.id and r.recipient_profile_id = v_me
           and r.status = 'pending'
      ) then 'request_received'
      else 'none'
    end as relationship_status
  from public.profiles p
  left join public.profile_cosmetics c on c.profile_id = p.id
  where p.id = p_profile_id;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 9) RPC: get_public_profiles (batched) — lobi/leaderboard avatar çözümü
--    Tek çağrı, N+1 yok. Showcase/relationship döndürmez (hafif).
-- ----------------------------------------------------------------------------
create or replace function public.get_public_profiles(p_ids uuid[])
returns table (
  profile_id uuid,
  username   text,
  avatar_id  text,
  level      int,
  active_avatar_frame_id text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    c.active_avatar_frame_id
  from public.profiles p
  left join public.profile_cosmetics c on c.profile_id = p.id
  where p.id = any(coalesce(p_ids, '{}'::uuid[]));
end
$fn$;

-- ----------------------------------------------------------------------------
-- 10) GRANTS
-- ----------------------------------------------------------------------------
revoke all on function public._social_level(uuid) from public;
grant  execute on function public._social_level(uuid) to anon, authenticated;

revoke all on function public.send_friend_request(uuid) from public;
grant  execute on function public.send_friend_request(uuid) to authenticated;

revoke all on function public.respond_friend_request(uuid, text) from public;
grant  execute on function public.respond_friend_request(uuid, text) to authenticated;

revoke all on function public.send_room_invite(uuid, text, text, text) from public;
grant  execute on function public.send_room_invite(uuid, text, text, text) to authenticated;

revoke all on function public.mark_notification_read(uuid) from public;
grant  execute on function public.mark_notification_read(uuid) to authenticated;

revoke all on function public.mark_all_notifications_read() from public;
grant  execute on function public.mark_all_notifications_read() to authenticated;

revoke all on function public.get_public_profile(uuid) from public;
grant  execute on function public.get_public_profile(uuid) to anon, authenticated;

revoke all on function public.get_public_profiles(uuid[]) from public;
grant  execute on function public.get_public_profiles(uuid[]) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 11) REALTIME: notifications tablosunu publication'a ekle (idempotent)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception
  when undefined_object then
    -- supabase_realtime publication yoksa sessizce geç (yerel/test ortamı).
    null;
end$$;

-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   -- iki test profili p1, p2 ile:
--   select public.send_friend_request('<p2>');               -- p2'ye friend_request notification
--   select public.respond_friend_request('<reqId>','accepted'); -- friends çift satır + accepted notif
--   select public.send_room_invite('<p2>','K6MEDT','conquest','/?conquest=K6MEDT');
--   select * from public.get_public_profile('<p2>');          -- gold YOK; relationship_status
--   select * from public.get_public_profiles(array['<p1>','<p2>']::uuid[]);
--   -- RLS: başka kullanıcının notification'ı görünmemeli:
--   select count(*) from public.notifications;                -- yalnız kendi satırların
-- ============================================================================
