-- ============================================================================
-- 20260718190000_dm_list_messages_ambiguous_fix
-- ----------------------------------------------------------------------------
-- ONARIM: dm_list_messages canlıda 400 / 42702 dönüyordu:
--   column reference "conversation_id" is ambiguous
--   (It could refer to either a PL/pgSQL variable or a table column.)
--
-- KÖK SEBEP: Fonksiyon RETURNS TABLE (... conversation_id uuid, created_at ... )
-- ile tanımlı. Bu OUTPUT kolonları PL/pgSQL'de scope'taki DEĞİŞKEN gibidir.
-- İç alt-sorgu `select * from public.dm_messages where conversation_id = ...`
-- şeklinde ALIAS'SIZ yazıldığı için `conversation_id` (ve `created_at`) hangisi:
-- tablo kolonu mu, output değişkeni mi → belirsiz → 42702.
--
-- DÜZELTME: İç tabloya alias (`dm`) ver ve TÜM kolonları açıkça nitele.
-- `select *` ve alias'sız kolon kullanımı kaldırıldı.
--
-- DEĞİŞMEYENLER (kasıtlı):
--   * İmza AYNI: dm_list_messages(p_conversation uuid, p_limit int) → client
--     `p_conversation`/`p_limit` named-arg ile çağırıyor; rename PGRST202 yapardı.
--   * SECURITY DEFINER + sabit search_path = public.
--   * cleared_at görünürlük mantığı (çağıran kendi cleared_at'inden önceki
--     mesajları görmez) aynen korundu.
--   * PUBLIC execute kapalı, yalnız authenticated grant.
--
-- Idempotent: yalnızca CREATE OR REPLACE FUNCTION. Tablo/veri/RLS'e dokunmaz.
-- ============================================================================

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

  -- İç alt-sorgu TAMAMEN nitelenmiş (alias `dm`): output-kolon değişkenleriyle
  -- (conversation_id / created_at) çakışma YOK. Dış sorgu alt-sorgu alias `m`.
  return query
    select m.id, m.conversation_id, m.sender_id, m.recipient_id,
           m.content, m.created_at, m.read_at
      from (
        select dm.id,
               dm.conversation_id,
               dm.sender_id,
               dm.recipient_id,
               dm.content,
               dm.created_at,
               dm.read_at
          from public.dm_messages dm
         where dm.conversation_id = p_conversation
           and (v_cleared is null or dm.created_at > v_cleared)
         order by dm.created_at desc
         limit v_lim
      ) m
     order by m.created_at asc;
end
$fn$;

-- GRANTS (idempotent): PUBLIC kapalı, yalnız authenticated.
revoke all on function public.dm_list_messages(uuid, int) from public;
grant  execute on function public.dm_list_messages(uuid, int) to authenticated;
