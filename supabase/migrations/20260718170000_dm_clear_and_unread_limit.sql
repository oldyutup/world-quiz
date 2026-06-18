-- ============================================================================
-- DM v2 — Kullanıcı-bazlı "Sohbeti temizle" + okunmamış mesaj spam sınırı
-- ============================================================================
-- 20260718160000_direct_messages.sql ÜZERİNE kurulur; o migration önce
-- uygulanmış olmalı. Client ile BİRLİKTE deploy edilir.
--
-- Bu migration üç şeyi ekler/değiştirir:
--
--   1) GÖRÜNÜRLÜK (per-user cleared_at):
--      dm_conversations'a cleared_a_at / cleared_b_at kolonları. Bir kullanıcı
--      "Sohbeti temizle" dediğinde YALNIZ kendi tarafının kolonu now() olur.
--      Mesaj satırları FİZİKSEL OLARAK SİLİNMEZ; karşı taraf tüm geçmişi görür.
--      dm_list_messages / dm_unread_summary çağıran için cleared_at ÖNCESİ
--      mesajları ARTIK döndürmez. Yeni mesaj geldiğinde sohbet normal akar.
--
--   2) OKUNMAMIŞ SPAM SINIRI (transaction-safe):
--      Bir kullanıcı, karşı taraf konuşmayı açıp mesajları OKUMADAN önce o
--      konuşmada en fazla 10 okunmamış mesaj bırakabilir. 11.'de 'unread_limit'
--      hatası. Mevcut anti-spam (500ms aralık, 10sn burst, duplicate) KORUNUR;
--      bu ek bir kural. Sayım, gönderim öncesi conversation satırı FOR UPDATE
--      ile kilitlenerek yapılır → çoklu sekme / eşzamanlı istek limiti bypass
--      edemez (ikinci istek ilkin commit'ini bekler, güncel sayıyı görür).
--
--   3) RPC: dm_clear_conversation(p_conversation) — çağıranın cleared_at'ini set
--      eder. Yalnız konuşmanın tarafı çağırabilir.
--
-- OTOMATİK SİLME / TTL / CRON YOK: mesajlar kendiliğinden silinmez. Tek
-- temizlik yolu kullanıcının bu RPC'si ve o da yalnız kendi görünümünü gizler.
--
-- Idempotent + elle (Supabase Studio SQL editor) uygulanabilir.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) GÖRÜNÜRLÜK kolonları — her kullanıcı için ayrı "bu andan öncesini gizle".
-- ----------------------------------------------------------------------------
alter table public.dm_conversations
  add column if not exists cleared_a_at timestamptz null,
  add column if not exists cleared_b_at timestamptz null;

-- ----------------------------------------------------------------------------
-- 2) RPC: dm_send_message — anti-spam + OKUNMAMIŞ SINIRI (transaction-safe).
--    Önceki sürümün davranışını birebir korur, üstüne:
--      a) v_conv kilidi (FOR UPDATE) → eşzamanlı gönderimler serialize.
--      b) okunmamış sayım (karşı tarafın cleared_at'i sonrası, read_at null).
--      c) >= 10 ise 'unread_limit'.
-- ----------------------------------------------------------------------------
create or replace function public.dm_send_message(p_recipient uuid, p_content text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me           uuid := auth.uid();
  v_conv         uuid;
  v_text         text;
  v_last_text    text;
  v_last_at      timestamptz;
  v_recent       int;
  v_recip_cleared timestamptz;
  v_unread       int;
  v_row          public.dm_messages;
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

  -- Eşzamanlı gönderimleri (çoklu sekme / iki istek) bu konuşma satırı üzerinde
  -- serialize et. Okunmamış limiti ve anti-spam sayımları bu kilit altında
  -- tutarlı; ikinci istek ilk transaction commit olana dek bekler.
  perform 1 from public.dm_conversations where id = v_conv for update;

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

  -- ── OKUNMAMIŞ SINIRI ──
  -- Karşı taraf bu konuşmayı açıp mesajları OKUYANA (read_at) kadar, ben en
  -- fazla 10 okunmamış mesaj bırakabilirim. Karşı taraf konuşmayı kendi tarafında
  -- TEMİZLEDİYSE (cleared_at) o mesajlar onun görünümünden kalktığı için sayılmaz.
  select case when user_a = p_recipient then cleared_a_at else cleared_b_at end
    into v_recip_cleared
    from public.dm_conversations
   where id = v_conv;

  select count(*) into v_unread
    from public.dm_messages
   where conversation_id = v_conv
     and sender_id       = v_me
     and recipient_id    = p_recipient
     and read_at is null
     and (v_recip_cleared is null or created_at > v_recip_cleared);

  if v_unread >= 10 then
    raise exception 'unread_limit' using errcode = 'P0001';
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
-- 3) RPC: dm_list_messages — cleared_at GÖRÜNÜRLÜĞÜ ile.
--    Çağıran kendi cleared_at'inden ÖNCEKİ mesajları görmez. Karşı taraf
--    etkilenmez (her tarafın kolonu ayrı).
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
  v_me      uuid := auth.uid();
  v_a       uuid;
  v_b       uuid;
  v_cleared timestamptz;
  v_lim     int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  -- Katılımcı doğrula + çağıranın kendi cleared_at'ini tek seçişte al.
  select c.user_a,
         c.user_b,
         case when v_me = c.user_a then c.cleared_a_at else c.cleared_b_at end
    into v_a, v_b, v_cleared
    from public.dm_conversations c
   where c.id = p_conversation;

  if v_a is null then
    raise exception 'not_participant' using errcode = '42501';
  end if;
  if v_me <> v_a and v_me <> v_b then
    raise exception 'not_participant' using errcode = '42501';
  end if;

  return query
    select m.id, m.conversation_id, m.sender_id, m.recipient_id,
           m.content, m.created_at, m.read_at
      from (
        select *
          from public.dm_messages
         where conversation_id = p_conversation
           and (v_cleared is null or created_at > v_cleared)
         order by created_at desc
         limit v_lim
      ) m
     order by m.created_at asc;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 4) RPC: dm_unread_summary — cleared_at GÖRÜNÜRLÜĞÜ ile.
--    Temizlenmiş (cleared_at öncesi) okunmamışlar badge'e sayılmaz.
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
    select m.sender_id, count(*)::int as cnt
      from public.dm_messages m
      join public.dm_conversations c on c.id = m.conversation_id
     where m.recipient_id = v_me
       and m.read_at is null
       and (
         (c.user_a = v_me and (c.cleared_a_at is null or m.created_at > c.cleared_a_at))
         or
         (c.user_b = v_me and (c.cleared_b_at is null or m.created_at > c.cleared_b_at))
       )
     group by m.sender_id
  ) t;

  return jsonb_build_object('total', v_total, 'by_user', v_by);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 5) RPC: dm_clear_conversation(p_conversation) — çağıranın cleared_at'i = now().
--    YALNIZ kendi görünümünü gizler; mesaj silinmez, karşı taraf etkilenmez.
-- ----------------------------------------------------------------------------
create or replace function public.dm_clear_conversation(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me  uuid := auth.uid();
  v_a   uuid;
  v_b   uuid;
  v_now timestamptz := now();
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select user_a, user_b into v_a, v_b
    from public.dm_conversations
   where id = p_conversation;

  if v_a is null or (v_me <> v_a and v_me <> v_b) then
    raise exception 'not_participant' using errcode = '42501';
  end if;

  if v_me = v_a then
    update public.dm_conversations set cleared_a_at = v_now where id = p_conversation;
  else
    update public.dm_conversations set cleared_b_at = v_now where id = p_conversation;
  end if;

  return jsonb_build_object('ok', true, 'cleared_at', v_now);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) GRANTS (idempotent; değişen/yeni fonksiyonlar)
-- ----------------------------------------------------------------------------
revoke all on function public.dm_send_message(uuid, text) from public;
grant  execute on function public.dm_send_message(uuid, text) to authenticated;

revoke all on function public.dm_list_messages(uuid, int) from public;
grant  execute on function public.dm_list_messages(uuid, int) to authenticated;

revoke all on function public.dm_unread_summary() from public;
grant  execute on function public.dm_unread_summary() to authenticated;

revoke all on function public.dm_clear_conversation(uuid) from public;
grant  execute on function public.dm_clear_conversation(uuid) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor; p1, p2 arkadaş olmalı):
--   -- Okunmamış sınırı: p1 olarak 10 mesaj at, 11. 'unread_limit' vermeli:
--   select public.dm_send_message('<p2>', 'm1'); ... (10 kez, içerik farklı)
--   select public.dm_send_message('<p2>', 'm11');   -- 'unread_limit'
--   -- p2 okur → p1 yeniden atabilir:
--   select public.dm_mark_read('<convId>');         -- p2 oturumunda
--   -- Temizleme: p1 temizler, p1 listesi boşalır, p2 dolu kalır:
--   select public.dm_clear_conversation('<convId>');-- p1
--   select * from public.dm_list_messages('<convId>'); -- p1: boş, p2: dolu
-- ============================================================================
