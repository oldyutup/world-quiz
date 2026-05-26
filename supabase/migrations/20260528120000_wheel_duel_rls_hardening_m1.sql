-- ============================================================================
-- Wheel Duel — RLS hardening · M1 (saf additive altyapı)
-- ============================================================================
-- AMAÇ
-- ----
-- Çark 1v1 (Wheel Duel) tablolarını ileride RPC-only yazma modeline geçirmek
-- için gereken altyapıyı oluşturur. Bu migration HİÇBİR mevcut davranışı
-- değiştirmez — yalnız yeni nesneler ekler. Mevcut "_anon" RLS politikaları
-- yerinde kalır, frontend dokunulmaz, oyun mid-flight kırılmaz.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_rooms / duel_group_players / duel_group_claims
--   • wheel_group_rooms / wheel_group_players
--   • flag_duel_queue / wheel_duel_queue
--   • conquest_*
--   • profiles, xp_events
--   • Mevcut wheel_duel_rooms / wheel_duel_players RLS politikaları
--     (wheel_rooms_select_all, wheel_rooms_insert_anon, wheel_rooms_update_anon,
--      wheel_rooms_delete_anon, wheel_players_*) — bilinçli olarak yerinde
--     bırakılıyor; M3'te değiştirilecek.
--   • Mevcut wheel_duel_rooms / wheel_duel_players SATIRLARI (backfill yok)
--   • supabase_realtime publication üyelikleri (wheel_duel_rooms,
--     wheel_duel_players) — claim tablosu KASTEN dahil edilmiyor.
--
-- YENİ NESNELER
-- -------------
--   • wheel_duel_players tablosuna iki yeni kolon:
--       profile_id  uuid null   — logged-in oyuncunun auth.users(id)'si
--       guest_id    text null   — misafir oyuncunun client-üretimli id'si
--   • public.wheel_duel_player_claims
--       (player_id PK, claim_token uuid, created_at) — INSERT-only, realtime
--       DIŞI, SELECT grant yok.
--   • public.wheel_duel_authorize_player(uuid, uuid) — yetki helper
--   • public.wheel_duel_authorize_host  (uuid, uuid, uuid) — host yetki helper
--
-- IDEMPOTENT
-- ----------
--   • "add column if not exists", "create table if not exists",
--     "drop policy if exists" + "create policy", "create or replace function".
--   • Migration tekrar çalıştırılırsa hata vermez.
--
-- TEHDİT MODELİ NOTU
-- ------------------
-- Bu migration TEK BAŞINA güvenlik kazancı sağlamaz; mevcut geniş RLS hâlâ
-- yerinde. M2 (RPC'ler) + M3 (RLS daraltma) tamamlanana kadar token
-- yardımcıları beklemede kalır. Bu sıralama bilinçli: önce altyapı, sonra
-- callable yol, en sonda lockdown — her adım bağımsız geri alınabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_duel_players — kimlik kolonları
-- ----------------------------------------------------------------------------
-- profile_id: logged-in oyuncuda auth.uid() ile eşleştirilir. NULL → misafir.
-- guest_id  : misafir oyuncuda client-üretimli stabil id (UUID metni).
--             NULL → logged-in. M2 RPC'leri tutarlılığı zorlayacak; bu
--             migration sadece kolonları ekler, constraint koymaz (mevcut
--             satırlar her ikisi de NULL kalır, ileride kullanılmayacak).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_duel_players
  add column if not exists profile_id uuid null;

alter table public.wheel_duel_players
  add column if not exists guest_id text null;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_duel_player_claims — özel claim-token deposu
-- ----------------------------------------------------------------------------
-- Token'lar wheel_duel_players ile aynı tabloda DURMAZ; eklenirse REPLICA
-- IDENTITY FULL nedeniyle realtime WAL akışında her aboneye gönderilirdi.
-- Ayrı tabloda tutarak (a) supabase_realtime publication'a eklemiyoruz,
-- (b) SELECT policy hiç eklemiyoruz → token sadece insert eden tarafta bilinir.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_duel_player_claims (
  player_id   uuid        primary key
                          references public.wheel_duel_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);

alter table public.wheel_duel_player_claims enable row level security;

-- INSERT açık (anon ve authenticated). Misafir bile join sırasında kendi
-- claim'ini bırakabilmeli. UPDATE/DELETE policy YOK → token rotate edilemez,
-- silinemez (player_id cascade ile silindiğinde otomatik temizlenir).
drop policy if exists "wheel_duel_player_claims_insert"
  on public.wheel_duel_player_claims;

create policy "wheel_duel_player_claims_insert"
  on public.wheel_duel_player_claims
  for insert
  to anon, authenticated
  with check (true);

-- Defense-in-depth: PostgREST yine de RLS'i uygular, ama SELECT için tablo
-- üstünde grant olmamasını da garanti altına al. (Supabase default tüm public
-- tablolarına anon+authenticated rolüne grant verir; biz select'i geri alıyoruz.)
revoke select, update, delete on public.wheel_duel_player_claims from anon, authenticated;
grant  insert                   on public.wheel_duel_player_claims to anon, authenticated;

-- NOT: alter publication supabase_realtime ADD TABLE wheel_duel_player_claims
-- ÇAĞRILMIYOR. Bu kasıtlı. Token asla broadcast edilmemeli.


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Yetki yardımcıları (read-only, SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Conquest pattern'inin birebir Wheel Duel karşılığı. M2 RPC'leri bu helper'ları
-- giriş noktası olarak kullanacak; M1 sırasında çağıran yok ama tablo şeması
-- ve grant'lar şimdiden hazır.
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bir player_id için: caller ya o satırın profile_id = auth.uid() sahibi
--     ya da claim_token eşleşen misafir mi?
create or replace function public.wheel_duel_authorize_player(
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
      from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c
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

revoke all     on function public.wheel_duel_authorize_player(uuid, uuid) from public;
grant  execute on function public.wheel_duel_authorize_player(uuid, uuid) to anon, authenticated;


-- (b) Verilen oda için: caller, oda host'unun ta kendisi mi?
--     host_player_id eşleşmesi + authorize_player ZORUNLU.
create or replace function public.wheel_duel_authorize_host(
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
      from public.wheel_duel_rooms r
     where r.id = p_room_id
       and r.host_player_id = p_player_id
       and public.wheel_duel_authorize_player(p_player_id, p_claim_token)
  );
$$;

revoke all     on function public.wheel_duel_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   -- Yeni kolonlar var mı?
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'wheel_duel_players'
--      and column_name in ('profile_id', 'guest_id');
--
--   -- Yeni tablo:
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'wheel_duel_player_claims';
--
--   -- Policy yalnız INSERT olmalı:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'wheel_duel_player_claims';
--
--   -- Grant durumu: anon/authenticated sadece INSERT'e sahip olmalı.
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'wheel_duel_player_claims'
--    order by grantee, privilege_type;
--
--   -- Claim tablosu realtime publication'da OLMAMALI:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename like 'wheel_duel_%';
--   -- Beklenen liste: yalnızca wheel_duel_rooms ve wheel_duel_players.
--
--   -- Fonksiyonlar (security definer flag'i):
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('wheel_duel_authorize_player', 'wheel_duel_authorize_host');
--
--   -- Mevcut "_anon" RLS politikaları HÂLÂ YERİNDE olmalı (M1 dokunmaz):
--   select policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_duel_rooms', 'wheel_duel_players')
--    order by tablename, cmd;
-- ============================================================================
