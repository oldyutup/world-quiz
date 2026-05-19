-- ============================================================================
-- Wheel Group — Server-side capacity guard
-- ============================================================================
-- Amac:
--   wheel_group_players insert akisinda max_players siniri sunucu tarafinda
--   da kontrol edilsin. Client kontrolu (WheelGroupGame.tsx joinRoomByCode)
--   yarisma kosullarinda yetersiz; bu trigger ile capacity asilamaz.
--
-- DOKUNMAZ:
--   • wheel_group_rooms / wheel_group_players tablolari (kolonlar, indexler,
--     RLS politikalari, realtime publication, var olan triggerlar)
--   • duel_*, wheel_duel_*, flag_duel_*, xp_events, profiles
--   • award_wheel_group_xp_event RPC
--
-- max_players kolonu init migration'da:
--   default 10, check (between 3 and 10).
-- Bu migration sadece BEFORE INSERT trigger ekler.
--
-- Idempotency:
--   • create or replace function
--   • drop trigger if exists + create trigger
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Capacity check trigger function
-- ----------------------------------------------------------------------------
-- Mantik: yeni player insert edilirken, ayni room_id icin mevcut player
-- sayisi >= room.max_players ise hata at. RAISE EXCEPTION code 'P0001'
-- (raise_exception) → client describeSupabaseError tarafindan generic
-- "Odaya katilinamadi" gosterilir; biz mesajdan "Oda dolu" kismini regex'le
-- yakalayabilir veya error message string match yapabiliriz.
--
-- ÖNEMLI: max_players=NULL gelirse (eski row) 10 olarak kabul et.
-- ----------------------------------------------------------------------------

create or replace function public.wheel_group_check_capacity()
returns trigger
language plpgsql
as $fn$
declare
  v_max  int;
  v_curr int;
begin
  select coalesce(max_players, 10)
    into v_max
    from public.wheel_group_rooms
   where id = new.room_id;

  if v_max is null then
    -- Oda yok; FK zaten patlatacak. Burada blok yok.
    return new;
  end if;

  select count(*)
    into v_curr
    from public.wheel_group_players
   where room_id = new.room_id;

  if v_curr >= v_max then
    raise exception 'wheel_group_room_full: %/% players', v_curr, v_max
      using errcode = 'P0001',
            hint    = 'Oda dolu';
  end if;

  return new;
end
$fn$;


-- ----------------------------------------------------------------------------
-- 2) BEFORE INSERT trigger
-- ----------------------------------------------------------------------------

drop trigger if exists wheel_group_players_capacity_check
  on public.wheel_group_players;

create trigger wheel_group_players_capacity_check
  before insert on public.wheel_group_players
  for each row
  execute function public.wheel_group_check_capacity();


-- ============================================================================
-- DONE
-- ============================================================================
-- Dogrulama (Studio SQL editor):
--
--   select tgname, tgtype
--     from pg_trigger
--    where tgrelid = 'public.wheel_group_players'::regclass
--      and tgname  = 'wheel_group_players_capacity_check';
--
--   -- Manuel test (5 oyunculu odaya 6. insert):
--   -- max_players=5 set edilmis bir oda icin 5. insert sonrasi 6. insert
--   -- "wheel_group_room_full: 5/5 players" hatasi atmalidir.
-- ============================================================================
