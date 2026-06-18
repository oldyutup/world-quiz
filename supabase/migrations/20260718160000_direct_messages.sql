-- ============================================================================
-- Birebir Özel Mesaj (DM) — yalnızca karşılıklı arkadaşlar arasında
-- ============================================================================
-- Amac:
--   Arkadaş listesi üzerinden 1-1 özel sohbet. Lobby/oda chat'inden TAMAMEN
--   AYRI veri modeli ve güvenlik kuralları:
--     - duel_messages / oda mesaj tablolarına YAZILMAZ.
--     - Her conversation tam olarak iki kullanıcı arasındadır ve canonical
--       sıralama (user_a < user_b) ile tekilleştirilir → aynı çift için tek satır.
--     - Tüm yazma yolları SECURITY DEFINER RPC'lerden geçer; sender daima
--       server'da auth.uid()'den belirlenir (client sahteleyemez).
--     - Yalnız karşılıklı (friends tablosunda kayıtlı) ve engellenmemiş
--       kullanıcılar mesajlaşabilir.
--
-- Tablolar:
--   dm_conversations, dm_messages
--
-- RPC'ler (hepsi SECURITY DEFINER, actor = auth.uid()):
--   dm_get_or_create_conversation, dm_send_message, dm_list_messages,
--   dm_mark_read, dm_unread_summary
--
-- GÜVENLİK (RLS):
--   * dm_conversations: SELECT yalnız taraf olan kullanıcı; yazma policy YOK → RPC.
--   * dm_messages:      SELECT yalnız sender VEYA recipient; yazma policy YOK → RPC.
--   → Başka kullanıcılar bu konuşmaları SQL/RLS veya istemci üzerinden okuyamaz.
--
-- Idempotent + elle uygulanır. Bağımlılık: profiles, friends, blocked_profiles
-- (is_blocked_between). Client ile BİRLİKTE deploy edilmeli.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) TABLOLAR
-- ----------------------------------------------------------------------------

-- Conversation: tam olarak iki kullanıcı. user_a < user_b (canonical) → çift
-- başına tek satır. last_message_* alanları liste/önizleme/sıralama için cache.
create table if not exists public.dm_conversations (
  id                   uuid        primary key default gen_random_uuid(),
  user_a               uuid        not null references public.profiles(id) on delete cascade,
  user_b               uuid        not null references public.profiles(id) on delete cascade,
  created_at           timestamptz not null default now(),
  last_message_at      timestamptz null,
  last_message_preview text        null,
  last_sender_id       uuid        null references public.profiles(id) on delete set null,
  check (user_a < user_b)
);

create unique index if not exists dm_conversations_pair_uniq
  on public.dm_conversations (user_a, user_b);
create index if not exists dm_conversations_user_a_idx
  on public.dm_conversations (user_a, last_message_at desc);
create index if not exists dm_conversations_user_b_idx
  on public.dm_conversations (user_b, last_message_at desc);

create table if not exists public.dm_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.dm_conversations(id) on delete cascade,
  sender_id       uuid        not null references public.profiles(id) on delete cascade,
  -- recipient_id denormalize: okunmamış sorgu + realtime filtre + RLS sadeliği.
  recipient_id    uuid        not null references public.profiles(id) on delete cascade,
  content         text        not null,
  created_at      timestamptz not null default now(),
  read_at         timestamptz null,
  check (sender_id <> recipient_id),
  check (char_length(content) between 1 and 500)
);

create index if not exists dm_messages_conv_created_idx
  on public.dm_messages (conversation_id, created_at desc);
-- Alıcıya göre okunmamış mesajlar (badge sayısı) için kısmi index.
create index if not exists dm_messages_recipient_unread_idx
  on public.dm_messages (recipient_id)
  where read_at is null;
create index if not exists dm_messages_recipient_created_idx
  on public.dm_messages (recipient_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 2) RLS — yalnız okuma; yazma SECURITY DEFINER RPC'lerden
-- ----------------------------------------------------------------------------

alter table public.dm_conversations enable row level security;
alter table public.dm_messages      enable row level security;

-- dm_conversations: yalnız taraf olan kullanıcı okuyabilir.
drop policy if exists "dm_conversations_select_party" on public.dm_conversations;
create policy "dm_conversations_select_party"
  on public.dm_conversations for select
  to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

-- dm_messages: yalnız gönderen veya alıcı okuyabilir. INSERT/UPDATE policy YOK
-- → client yazamaz; gönderme/okundu işaretleme yalnız RPC'den (definer).
drop policy if exists "dm_messages_select_party" on public.dm_messages;
create policy "dm_messages_select_party"
  on public.dm_messages for select
  to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3) Yardımcı: _dm_are_friends(a, b) — karşılıklı arkadaşlık var mı?
--    friends tablosu her arkadaşlık için iki yönlü satır tutar; tek yön kontrolü
--    yeterli ama biz açıkça (a→b) satırını arıyoruz.
-- ----------------------------------------------------------------------------
create or replace function public._dm_are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.friends
     where profile_id = p_a and friend_profile_id = p_b
  );
$fn$;

revoke all on function public._dm_are_friends(uuid, uuid) from public;
grant  execute on function public._dm_are_friends(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) Internal: _dm_resolve_conversation(me, other) → conversation id
--    Canonical (least/greatest) ile çift başına tek satır; yoksa oluşturur.
--    Arkadaşlık + block kontrolü ÇAĞIRAN RPC'de yapılır.
-- ----------------------------------------------------------------------------
create or replace function public._dm_resolve_conversation(p_me uuid, p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_a    uuid := least(p_me, p_other);
  v_b    uuid := greatest(p_me, p_other);
  v_id   uuid;
begin
  insert into public.dm_conversations (user_a, user_b)
  values (v_a, v_b)
  on conflict (user_a, user_b) do nothing;

  select id into v_id
    from public.dm_conversations
   where user_a = v_a and user_b = v_b;

  return v_id;
end
$fn$;

revoke all on function public._dm_resolve_conversation(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5) RPC: dm_get_or_create_conversation(p_other) → conversation id
--    Modal açılışında çağrılır. Arkadaşlık + block doğrular.
-- ----------------------------------------------------------------------------
create or replace function public.dm_get_or_create_conversation(p_other uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_other is null or p_other = v_me then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if not public._dm_are_friends(v_me, p_other) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if public.is_blocked_between(v_me, p_other) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

  v_id := public._dm_resolve_conversation(v_me, p_other);
  return jsonb_build_object('ok', true, 'conversation_id', v_id);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) RPC: dm_send_message(p_recipient, p_content) → mesaj satırı
--    sender = auth.uid() (client sahteleyemez). Arkadaşlık + block + içerik
--    doğrulaması + hafif anti-spam (rate-limit + duplicate). Conversation'ı
--    kendisi çözer (canonical); client conversation id GÖNDERMEZ.
-- ----------------------------------------------------------------------------
create or replace function public.dm_send_message(p_recipient uuid, p_content text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me        uuid := auth.uid();
  v_conv      uuid;
  v_text      text;
  v_last_text text;
  v_last_at   timestamptz;
  v_recent    int;
  v_row       public.dm_messages;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_recipient is null or p_recipient = v_me then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if not public._dm_are_friends(v_me, p_recipient) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if public.is_blocked_between(v_me, p_recipient) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

  v_text := btrim(coalesce(p_content, ''));
  if length(v_text) = 0 then
    raise exception 'empty_message' using errcode = '22023';
  end if;
  if length(v_text) > 500 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;

  v_conv := public._dm_resolve_conversation(v_me, p_recipient);

  -- ── Hafif anti-spam (lobby chat ile aynı ruh) ──
  -- a) min aralık: 500ms içinde art arda iki mesaj → rate_limited.
  -- b) burst: son 10sn'de 10+ mesaj → rate_limited.
  -- c) duplicate: son mesajla birebir aynı içerik + 4sn içinde → duplicate_message.
  select content, created_at into v_last_text, v_last_at
    from public.dm_messages
   where conversation_id = v_conv and sender_id = v_me
   order by created_at desc
   limit 1;

  if v_last_at is not null and v_last_at > now() - interval '500 milliseconds' then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if v_last_text is not null and v_last_text = v_text
     and v_last_at > now() - interval '4 seconds' then
    raise exception 'duplicate_message' using errcode = 'P0001';
  end if;

  select count(*) into v_recent
    from public.dm_messages
   where conversation_id = v_conv and sender_id = v_me
     and created_at > now() - interval '10 seconds';
  if v_recent >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.dm_messages (conversation_id, sender_id, recipient_id, content)
  values (v_conv, v_me, p_recipient, v_text)
  returning * into v_row;

  update public.dm_conversations
     set last_message_at      = v_row.created_at,
         last_message_preview = left(v_text, 120),
         last_sender_id       = v_me
   where id = v_conv;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'conversation_id', v_row.conversation_id,
    'sender_id', v_row.sender_id,
    'recipient_id', v_row.recipient_id,
    'content', v_row.content,
    'created_at', v_row.created_at,
    'read_at', v_row.read_at
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 7) RPC: dm_list_messages(p_conversation, p_limit) → son N mesaj (artan sıra)
--    Yalnız taraf olan kullanıcı okuyabilir.
-- ----------------------------------------------------------------------------
create or replace function public.dm_list_messages(
  p_conversation uuid,
  p_limit        int default 50
)
returns table (
  id              uuid,
  conversation_id uuid,
  sender_id       uuid,
  recipient_id    uuid,
  content         text,
  created_at      timestamptz,
  read_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_ok boolean;
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select (c.user_a = v_me or c.user_b = v_me) into v_ok
    from public.dm_conversations c
   where c.id = p_conversation;

  if not coalesce(v_ok, false) then
    raise exception 'not_participant' using errcode = '42501';
  end if;

  return query
    select m.id, m.conversation_id, m.sender_id, m.recipient_id,
           m.content, m.created_at, m.read_at
      from (
        select *
          from public.dm_messages
         where conversation_id = p_conversation
         order by created_at desc
         limit v_lim
      ) m
     order by m.created_at asc;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 8) RPC: dm_mark_read(p_conversation) → bu konuşmadaki BANA gelen okunmamışlar
--    okundu. Diğer konuşmalara dokunmaz. Donus: { ok, updated }
-- ----------------------------------------------------------------------------
create or replace function public.dm_mark_read(p_conversation uuid)
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

  update public.dm_messages
     set read_at = now()
   where conversation_id = p_conversation
     and recipient_id    = v_me
     and read_at is null;

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'updated', v_n);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 9) RPC: dm_unread_summary() → { total, by_user: { "<senderId>": count } }
--    Arkadaşlar butonundaki toplam badge + arkadaş satırı başına okunmamış nokta.
--    Tek çağrı, N+1 yok.
-- ----------------------------------------------------------------------------
create or replace function public.dm_unread_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me     uuid := auth.uid();
  v_total  int;
  v_by     jsonb;
begin
  if v_me is null then
    return jsonb_build_object('total', 0, 'by_user', '{}'::jsonb);
  end if;

  select
    coalesce(sum(cnt), 0),
    coalesce(jsonb_object_agg(sender_id::text, cnt), '{}'::jsonb)
  into v_total, v_by
  from (
    select sender_id, count(*)::int as cnt
      from public.dm_messages
     where recipient_id = v_me and read_at is null
     group by sender_id
  ) t;

  return jsonb_build_object('total', v_total, 'by_user', v_by);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 10) GRANTS
-- ----------------------------------------------------------------------------
revoke all on function public.dm_get_or_create_conversation(uuid) from public;
grant  execute on function public.dm_get_or_create_conversation(uuid) to authenticated;

revoke all on function public.dm_send_message(uuid, text) from public;
grant  execute on function public.dm_send_message(uuid, text) to authenticated;

revoke all on function public.dm_list_messages(uuid, int) from public;
grant  execute on function public.dm_list_messages(uuid, int) to authenticated;

revoke all on function public.dm_mark_read(uuid) from public;
grant  execute on function public.dm_mark_read(uuid) to authenticated;

revoke all on function public.dm_unread_summary() from public;
grant  execute on function public.dm_unread_summary() to authenticated;

-- ----------------------------------------------------------------------------
-- 11) REALTIME: dm_messages tablosunu publication'a ekle (idempotent)
--     Aboneler RLS'e tabidir → bir kullanıcı yalnız sender/recipient olduğu
--     satırların INSERT event'ini alır. Client ayrıca recipient_id=eq.<me>
--     filtresiyle yalnız KENDİNE gelen mesajları dinler.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
exception
  when undefined_object then
    null;  -- supabase_realtime yoksa (yerel/test) sessizce geç.
end$$;

-- ============================================================================
-- Doğrulama (Studio SQL editor; p1, p2 arkadaş olmalı):
--   select public.dm_get_or_create_conversation('<p2>');         -- conversation_id
--   select public.dm_send_message('<p2>', 'Selam!');             -- mesaj satırı
--   select * from public.dm_list_messages('<convId>');           -- p1+p2 görür
--   select public.dm_unread_summary();                           -- p2: total=1
--   select public.dm_mark_read('<convId>');                      -- p2: updated=1
--   -- Arkadaş olmayana:
--   select public.dm_send_message('<stranger>', 'x');            -- 'not_friends'
--   -- RLS: 3. kullanıcı bu mesajları göremez:
--   select count(*) from public.dm_messages;                     -- yalnız kendi satırların
-- ============================================================================
