-- ============================================================================
-- Sosyal: Engelleme (block) + Arkadaşlıktan çıkarma (remove_friend) — aktivasyon
-- ============================================================================
-- Amac:
--   20260715121000_social_core.sql'de TODO bırakılan iki yolu tamamlar:
--     1) Arkadaşlıktan çıkarma (remove_friend) — iki yönlü friends satırı silinir.
--     2) Engelleme (block) — arkadaş OLSUN/OLMASIN herhangi bir oyuncu engellenir;
--        engellenen kişi engelleyene istek/davet gönderemez, mesajları görünmez.
--
--   NOT (tablo seçimi): Görevde önerilen `user_blocks` yerine social_core.sql'de
--   ZATEN var olan public.blocked_profiles tablosu kullanıldı (aynı kolonlar:
--   blocker_profile_id / blocked_profile_id / created_at, PK ikili). "Mevcut
--   yapıya en az zarar" ilkesi: yeni tablo + yeni RLS + yeni realtime üyeliği
--   açmak yerine var olanı aktive etmek daha güvenli. Eksikleri tamamlandı
--   (self-block guard + listeleme indeksi).
--
-- GÜVENLİK:
--   * blocked_profiles: SELECT yalnız blocker (social_core.sql'de mevcut).
--     INSERT/DELETE policy YOK → tüm yazma SECURITY DEFINER RPC'lerden geçer.
--     Client doğrudan tabloya yazamaz/silemez (notifications deseniyle aynı).
--   * Tüm RPC'ler actor = auth.uid(); kullanıcı yalnız KENDİ block/arkadaşlık
--     ilişkisini değiştirebilir. Başkasının ilişkisi etkilenemez.
--   * Engelleme SESSİZ: engellenen kişiye bildirim ÜRETİLMEZ.
--
-- KAPSAM (block enforcement):
--   * send_friend_request / respond_friend_request / send_room_invite →
--     iki yönlü block kontrolü eklendi (firm).
--   * Quick match: flag_duel_quick_match + country_duel_quick_match aday
--     sorgusuna block dışlaması eklendi (firm, iki mod). wheel_duel_quick_match
--     fonksiyon TANIMI repo migration'larında YOK (yalnız yorumlarda referans;
--     muhtemelen DB'ye elle uygulanmış) → güvenle yeniden üretilemediği için
--     bu modda matchmaking block UYGULANMADI (raporda belirtildi).
--   * Room join / diğer mod matchmaking: bu fazda kapsam dışı (raporda belirtildi).
--
-- Idempotent (create or replace + guard'lı alter) + elle uygulanır. Bağımlılık:
--   20260715121000_social_core.sql (blocked_profiles, friends, friend_requests,
--   notifications, _social_level, send_friend_request, respond_friend_request,
--   send_room_invite, get_public_profile),
--   20260715123000_social_search_profiles.sql (search_public_profiles),
--   20260620120000_flag_duel_quick_match_set_host.sql (flag_duel_quick_match),
--   20260701120000_country_duel_quick_match.sql (country_duel_quick_match).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) blocked_profiles: self-block guard + listeleme indeksi
-- ----------------------------------------------------------------------------
alter table public.blocked_profiles
  drop constraint if exists blocked_profiles_no_self;
alter table public.blocked_profiles
  add  constraint blocked_profiles_no_self
       check (blocker_profile_id <> blocked_profile_id);

create index if not exists blocked_profiles_blocker_idx
  on public.blocked_profiles (blocker_profile_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 2) Yardımcı: is_blocked_between(a, b) — iki yönden herhangi biri engellemiş mi?
--    SECURITY DEFINER → çağıran (auth user) tablo SELECT iznine bağlı değil;
--    RPC içlerinden de güvenle çağrılır.
-- ----------------------------------------------------------------------------
create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.blocked_profiles b
     where (b.blocker_profile_id = p_a and b.blocked_profile_id = p_b)
        or (b.blocker_profile_id = p_b and b.blocked_profile_id = p_a)
  );
$fn$;

-- ----------------------------------------------------------------------------
-- 3) RPC: block_user(target)
--    * Kendini/null/olmayan profili reddet.
--    * block kaydını upsert (idempotent).
--    * Varsa iki yönlü arkadaşlık satırlarını sil.
--    * İki yönlü pending friend_request'leri 'cancelled' yap.
--    * İki yön arası friend_request bildirimlerini temizle (pending olanın izi).
--    * SESSİZ — engellenen kişiye yeni bildirim üretmez.
-- ----------------------------------------------------------------------------
create or replace function public.block_user(p_target uuid)
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
  if p_target is null then
    raise exception 'target_required' using errcode = '22023';
  end if;
  if p_target = v_me then
    raise exception 'cannot_block_self' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_target) then
    raise exception 'target_not_found' using errcode = 'P0001';
  end if;

  -- Engel kaydı (idempotent — tekrar engellemek hata vermez).
  insert into public.blocked_profiles (blocker_profile_id, blocked_profile_id)
  values (v_me, p_target)
  on conflict (blocker_profile_id, blocked_profile_id) do nothing;

  -- Arkadaşlık varsa iki yönlü kaldır.
  delete from public.friends
   where (profile_id = v_me     and friend_profile_id = p_target)
      or (profile_id = p_target and friend_profile_id = v_me);

  -- İki yön arası bekleyen istekleri iptal et.
  update public.friend_requests
     set status = 'cancelled', updated_at = now()
   where status = 'pending'
     and (
       (requester_profile_id = v_me     and recipient_profile_id = p_target)
       or (requester_profile_id = p_target and recipient_profile_id = v_me)
     );

  -- İki yön arası friend_request bildirimlerini temizle (artık aksiyonsuz).
  delete from public.notifications n
   where n.type = 'friend_request'
     and (
       (n.recipient_profile_id = v_me     and n.actor_profile_id = p_target)
       or (n.recipient_profile_id = p_target and n.actor_profile_id = v_me)
     );

  return jsonb_build_object('ok', true);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 4) RPC: unblock_user(target) — yalnız kendi block kaydını siler (idempotent).
--    Otomatik arkadaşlık KURMAZ.
-- ----------------------------------------------------------------------------
create or replace function public.unblock_user(p_target uuid)
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
  if p_target is null then
    raise exception 'target_required' using errcode = '22023';
  end if;

  delete from public.blocked_profiles
   where blocker_profile_id = v_me and blocked_profile_id = p_target;

  return jsonb_build_object('ok', true);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 5) RPC: list_blocked_users() — kendi engellediklerim (avatar/username/level).
--    Gold DÖNDÜRMEZ (public alanlar). N+1 yok.
-- ----------------------------------------------------------------------------
create or replace function public.list_blocked_users()
returns table (
  profile_id             uuid,
  username               text,
  avatar_id              text,
  level                  int,
  active_avatar_frame_id text,
  blocked_at             timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return;
  end if;
  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    c.active_avatar_frame_id,
    b.created_at
  from public.blocked_profiles b
  join public.profiles p on p.id = b.blocked_profile_id
  left join public.profile_cosmetics c on c.profile_id = p.id
  where b.blocker_profile_id = v_me
  order by b.created_at desc;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) RPC: remove_friend(target) — iki yönlü arkadaşlık satırını siler.
--    Engellemez; karşı taraf sonradan tekrar istek atabilir. WHERE her iki
--    dalında v_me geçtiği için kullanıcı YALNIZ kendi ilişkisini silebilir.
-- ----------------------------------------------------------------------------
create or replace function public.remove_friend(p_target uuid)
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
  if p_target is null then
    raise exception 'target_required' using errcode = '22023';
  end if;

  delete from public.friends
   where (profile_id = v_me     and friend_profile_id = p_target)
      or (profile_id = p_target and friend_profile_id = v_me);

  return jsonb_build_object('ok', true);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 7) send_friend_request — block kontrolü EKLENDİ (social_core.sql gövdesi).
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

  -- Block (iki yön): engelli ilişkide istek gönderilemez.
  if public.is_blocked_between(v_me, p_recipient) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

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
-- 8) respond_friend_request — block kontrolü EKLENDİ (social_core.sql gövdesi).
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

  -- Block (iki yön): engelli ilişkide istek kabul edilemez (savunma katmanı —
  -- block_user pending istekleri zaten iptal eder, ama yarış olasılığına karşı).
  if public.is_blocked_between(v_me, v_req.requester_profile_id) then
    raise exception 'blocked_between' using errcode = 'P0001';
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
-- 9) send_room_invite — block kontrolü EKLENDİ (social_core.sql gövdesi).
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

  -- Block (iki yön): engelli ilişkide oda/oyun daveti gönderilemez.
  if public.is_blocked_between(v_me, p_recipient) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

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
-- 10) get_public_profile — relationship_status'a 'blocked' / 'blocked_by' eklendi
--     (social_core.sql gövdesi; yalnız CASE genişledi).
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
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = v_me and b.blocked_profile_id = p.id
      ) then 'blocked'
      when exists (
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = p.id and b.blocked_profile_id = v_me
      ) then 'blocked_by'
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
-- 11) search_public_profiles — relationship_status'a 'blocked' / 'blocked_by'
--     eklendi (social_search_profiles.sql gövdesi; yalnız CASE genişledi).
-- ----------------------------------------------------------------------------
create or replace function public.search_public_profiles(p_query text)
returns table (
  profile_id             uuid,
  username               text,
  avatar_id              text,
  level                  int,
  profile_code           text,
  active_avatar_frame_id text,
  relationship_status    text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me   uuid := auth.uid();
  v_q    text;
  v_like text;
  v_code text;
begin
  -- "@username" girişini ve baştaki/sondaki boşlukları normalize et.
  v_q := lower(btrim(coalesce(p_query, '')));
  v_q := btrim(ltrim(v_q, '@'));

  -- Minimum 2 karakter (aşırı geniş arama + DoS engeli).
  if length(v_q) < 2 then
    return;
  end if;

  -- LIKE özel karakterlerini (\ _ %) escape et — username'lerde '_' geçerli.
  v_like := replace(v_q, '\', '\\');
  v_like := replace(v_like, '_', '\_');
  v_like := replace(v_like, '%', '\%');

  v_code := upper(v_q);

  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    p.profile_code,
    c.active_avatar_frame_id,
    case
      when v_me is null then 'none'
      when p.id = v_me then 'self'
      when exists (
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = v_me and b.blocked_profile_id = p.id
      ) then 'blocked'
      when exists (
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = p.id and b.blocked_profile_id = v_me
      ) then 'blocked_by'
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
  where p.username is not null
    and length(btrim(p.username)) > 0
    and (
      p.username_normalized like v_like || '%' escape '\'
      or p.profile_code = v_code
    )
  order by
    (p.profile_code = v_code) desc,         -- tam kod eşleşmesi en üstte
    (p.username_normalized = v_q) desc,      -- tam username eşleşmesi sonra
    lower(coalesce(p.username, '')) asc
  limit 20;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 12) GRANTS (yeni fonksiyonlar)
-- ----------------------------------------------------------------------------
revoke all on function public.is_blocked_between(uuid, uuid) from public;
grant  execute on function public.is_blocked_between(uuid, uuid) to authenticated;

revoke all on function public.block_user(uuid) from public;
grant  execute on function public.block_user(uuid) to authenticated;

revoke all on function public.unblock_user(uuid) from public;
grant  execute on function public.unblock_user(uuid) to authenticated;

revoke all on function public.list_blocked_users() from public;
grant  execute on function public.list_blocked_users() to authenticated;

revoke all on function public.remove_friend(uuid) from public;
grant  execute on function public.remove_friend(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 13) Matchmaking block — flag_duel_quick_match (aday sorgusuna block dışlaması).
--     20260620120000_flag_duel_quick_match_set_host.sql gövdesi BİREBİR; tek
--     değişiklik: aday WHERE'ine "and not is_blocked_between(...)" eklendi.
-- ----------------------------------------------------------------------------
create or replace function public.flag_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_total_rounds    int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text,
  p_first_flag      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  if auth.uid() is null then
    raise exception 'flag_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  if p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'flag_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_max_level_diff < 0 then
    raise exception 'flag_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' or coalesce(p_first_flag, '') = '' then
    raise exception 'flag_duel_quick_match: empty room_code or first_flag';
  end if;

  v_my_level := public.flag_duel_mode_level(p_profile_id);

  -- Stale-row self-heal (preserved from 20260521130000)
  update public.flag_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.flag_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.total_rounds      = p_total_rounds
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- host_player_id = candidate (waiter). Hem flag_duel_authorize_host
    -- manuel branch'i hem client-side isHost kontrolü bu kolon üzerinden
    -- DETERMINISTIK çalışır; joined_at tie-break belirsizliği biter.
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      total_rounds,
      current_round,
      is_golden_round,
      current_flag,
      current_flag_at,
      room_source,
      host_player_id
    ) values (
      p_room_code,
      'playing',
      60,
      p_region,
      v_started_at,
      p_total_rounds,
      1,
      false,
      p_first_flag,
      v_started_at,
      'quick_match',
      v_candidate.player_id
    )
    returning id into v_room_id;

    insert into public.duel_players (id, room_id, name, score)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0);

    insert into public.duel_players (id, room_id, name, score)
      values (p_player_id, v_room_id, p_player_name, 0);

    update public.flag_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.flag_duel_queue as q (
      profile_id, player_id, player_name,
      total_rounds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, p_player_name,
      p_total_rounds, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id       = excluded.player_id,
          player_name     = excluded.player_name,
          total_rounds    = excluded.total_rounds,
          region          = excluded.region,
          mode_level      = excluded.mode_level,
          max_level_diff  = excluded.max_level_diff,
          matched_room_id = excluded.matched_room_id,
          expires_at      = excluded.expires_at,
          updated_at      = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  insert into public.flag_duel_queue as q (
    profile_id, player_id, player_name,
    total_rounds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, p_player_name,
    p_total_rounds, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id      = excluded.player_id,
        player_name    = excluded.player_name,
        total_rounds   = excluded.total_rounds,
        region         = excluded.region,
        mode_level     = excluded.mode_level,
        max_level_diff = excluded.max_level_diff,
        expires_at     = excluded.expires_at,
        updated_at     = excluded.updated_at
    where q.matched_room_id is null;

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;

revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;
grant  execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 14) Matchmaking block — country_duel_quick_match (aday sorgusuna block dışlaması).
--     20260701120000_country_duel_quick_match.sql gövdesi BİREBİR; tek değişiklik:
--     aday WHERE'ine "and not is_blocked_between(...)" eklendi.
-- ----------------------------------------------------------------------------
create or replace function public.country_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_duration        int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  -- ── Auth check ─────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'country_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'country_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  if p_duration is null then
    raise exception 'country_duel_quick_match: duration_required';
  end if;
  if p_duration not in (30, 60, 120, 180, 300) then
    raise exception 'country_duel_quick_match: invalid duration %', p_duration;
  end if;
  if p_max_level_diff is null then
    raise exception 'country_duel_quick_match: max_level_diff_required';
  end if;
  if p_max_level_diff < 0 then
    raise exception 'country_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' then
    raise exception 'country_duel_quick_match: empty room_code';
  end if;
  if coalesce(btrim(p_player_name), '') = '' then
    raise exception 'country_duel_quick_match: empty player_name';
  end if;
  if p_player_id is null then
    raise exception 'country_duel_quick_match: player_id_required';
  end if;
  if coalesce(btrim(p_region), '') = '' then
    raise exception 'country_duel_quick_match: empty region';
  end if;

  -- ── Caller'ın level'ı ──────────────────────────────────────────────────
  v_my_level := public.country_duel_mode_level(p_profile_id);

  -- ── Stale-row self-heal ────────────────────────────────────────────────
  update public.country_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  -- ── Mevcut queue satırı: paralel RPC bizi zaten eşleştirmiş mi? ────────
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  -- ── Uygun aday ara (FOR UPDATE SKIP LOCKED ile race-safe) ──────────────
  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.country_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.duration_seconds  = p_duration
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      room_source,
      host_player_id
    ) values (
      p_room_code,
      'playing',
      p_duration,
      p_region,
      v_started_at,
      'quick_match',
      v_candidate.player_id
    )
    returning id into v_room_id;

    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0,
              v_candidate.profile_id, v_now);

    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (p_player_id, v_room_id, btrim(p_player_name), 0,
              p_profile_id, v_now);

    update public.country_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.country_duel_queue as q (
      profile_id, player_id, player_name,
      duration_seconds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, btrim(p_player_name),
      p_duration, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id        = excluded.player_id,
          player_name      = excluded.player_name,
          duration_seconds = excluded.duration_seconds,
          region           = excluded.region,
          mode_level       = excluded.mode_level,
          max_level_diff   = excluded.max_level_diff,
          matched_room_id  = excluded.matched_room_id,
          expires_at       = excluded.expires_at,
          updated_at       = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  insert into public.country_duel_queue as q (
    profile_id, player_id, player_name,
    duration_seconds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, btrim(p_player_name),
    p_duration, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id        = excluded.player_id,
        player_name      = excluded.player_name,
        duration_seconds = excluded.duration_seconds,
        region           = excluded.region,
        mode_level       = excluded.mode_level,
        max_level_diff   = excluded.max_level_diff,
        expires_at       = excluded.expires_at,
        updated_at       = excluded.updated_at
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;

revoke all on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text)    from public;
grant  execute on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor, iki test profili p1/p2):
--   select public.block_user('<p2>');          -- friends/pending/notif temizlenir
--   select * from public.list_blocked_users(); -- p2 görünür
--   select public.send_friend_request('<p2>'); -- 'blocked_between' hatası
--   select public.send_room_invite('<p2>','K6MEDT','conquest','/?conquest=K6MEDT'); -- hata
--   select relationship_status from public.get_public_profile('<p2>'); -- 'blocked'
--   select public.unblock_user('<p2>');        -- engel kalkar; otomatik arkadaşlık YOK
--   select public.remove_friend('<p2>');       -- iki yönlü friends satırı silinir
--   -- RLS: başka kullanıcının block listesi görünmemeli (SELECT yalnız blocker).
-- ============================================================================
