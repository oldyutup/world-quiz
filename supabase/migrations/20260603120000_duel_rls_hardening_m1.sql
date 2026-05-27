-- ============================================================================
-- Duel (Online 1v1 Ülke Yaz) — RLS hardening · M1 (saf additive altyapı)
-- ============================================================================
-- AMAÇ
-- ----
-- DuelGame.tsx'in kullandığı legacy `duel_*` tablolarını (duel_rooms,
-- duel_players, duel_claims, duel_messages) ileride RPC-only yazma modeline
-- geçirmek için gereken altyapıyı oluşturur. Bu migration HİÇBİR mevcut
-- davranışı değiştirmez — yalnız yeni nesneler ekler. Mevcut geniş RLS
-- politikaları (Studio'da kurulmuş `anon FOR ALL USING(true) WITH CHECK(true)`
-- pattern'i) yerinde kalır, frontend dokunulmaz, oyun mid-flight kırılmaz.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel ve wheel_group hardening'inde
-- üç kez doğrulandı (20260528–20260530 ve 20260531–20260602). Bu dosya aynı
-- pattern'in birebir `duel_*` karşılığıdır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages MEVCUT RLS
--     politikaları (anon + authenticated FOR ALL / USING(true) WITH CHECK(true))
--     bilinçli olarak yerinde bırakılıyor; M3'te değiştirilecek.
--   • duel_rooms / duel_players / duel_claims / duel_messages MEVCUT SATIRLARI
--     (backfill yok — duel_players.profile_id ve guest_id NULL kalır; eski
--     satırlar lockdown sonrasında zaten yazılmaz, yalnız okunur).
--   • duel_group_* tabloları (kendi M1'ini ayrıca alacak).
--   • wheel_duel_* ve wheel_group_* (kendi M1/M2/M3 setleri mevcut).
--   • flag_duel_queue, flag_duel_quick_match / flag_duel_cancel_quick_match RPC
--     ve flag_duel_mode_level helper'ı.
--   • cleanup_expired_duel_lobbies RPC (DuelGame.tsx:1424 çağırıyor).
--   • duel_players replica identity full (20260520120000 ile açıldı, koruyoruz).
--   • duel_group_rooms_cleanup_after_player_delete trigger ve onun açtığı
--     duel_group_players replica identity full.
--   • duel_group_claims_all_authenticated policy (20260522120000).
--   • supabase_realtime publication üyelikleri (duel_rooms, duel_players,
--     duel_claims, duel_messages publication'da olduğu gibi kalır; yeni
--     duel_player_claims tablosu KASTEN dahil edilmez).
--   • conquest_*, wheel_duel_quick_match, profiles, xp_events.
--
-- YENİ NESNELER
-- -------------
--   • duel_players tablosuna iki yeni kolon:
--       profile_id  uuid null   — logged-in oyuncunun auth.users(id)'si
--       guest_id    text null   — misafir oyuncunun client-üretimli id'si
--   • duel_rooms tablosuna bir yeni kolon:
--       host_player_id uuid null  — oda host'unun duel_players.id'si.
--                                   Mevcut DuelGame.tsx 1v1 modelinde host
--                                   kavramı yalnız client-side `players[0]`
--                                   referansıydı; RPC tabanlı host-only
--                                   aksiyonlar (startGame, finish, accept_rematch,
--                                   handle_disconnect) için DB tarafında host
--                                   kimliği gerekiyor. NULL bırakılır → eski
--                                   satırlarda etki yok; M2 RPC'leri yeni
--                                   odalarda doldurur.
--   • public.duel_player_claims
--       (player_id PK FK→duel_players.id ON DELETE CASCADE,
--        claim_token uuid, created_at timestamptz)
--       INSERT-only, SELECT grant YOK, realtime publication'a EKLENMEZ.
--   • public.duel_authorize_player(uuid, uuid) — player yetki helper'ı
--   • public.duel_authorize_host  (uuid, uuid, uuid) — host yetki helper'ı
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
-- yerinde. M2 (RPC'ler) + FE switch + M3 (RLS daraltma) tamamlanana kadar
-- token yardımcıları beklemede kalır. Bu sıralama bilinçli: önce altyapı,
-- sonra callable yol, en sonda lockdown — her adım bağımsız geri alınabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_players — kimlik kolonları
-- ----------------------------------------------------------------------------
-- profile_id: logged-in oyuncuda auth.uid() ile eşleştirilir. NULL → misafir.
-- guest_id  : misafir oyuncuda client-üretimli stabil id (UUID metni).
--             NULL → logged-in. M2 RPC'leri tutarlılığı zorlayacak (XOR check);
--             bu migration sadece kolonları ekler, constraint koymaz (mevcut
--             satırlar her ikisi de NULL kalır, eski yolların ilerideki
--             okumaları bozulmasın). Eski direkt-yazma yolları (lockdown
--             öncesi cached client) bu kolonları doldurmadan INSERT atmaya
--             devam edebilir; nullable olduğu için kabul edilir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_players
  add column if not exists profile_id uuid null;

alter table public.duel_players
  add column if not exists guest_id text null;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_rooms — host_player_id kolonu
-- ----------------------------------------------------------------------------
-- DuelGame.tsx 1v1 modelinde host kavramı yalnız client-side `players[0]`
-- referansıydı (DB şemasında host kolonu yok). M2'de eklenecek host-only
-- RPC'lerin (start_game, finish_game, accept_rematch, handle_disconnect)
-- DB tarafında doğrulayabileceği bir host kimliği gerekiyor.
--
-- Nullable bırakılıyor → mevcut canlı satırlar NULL kalır (etki yok; bu
-- satırlar zaten kısa ömürlü 'waiting' veya tamamlanmış 'finished'). Yeni
-- odalarda M2'nin duel_create_room RPC'si bu kolonu createRoom çağrısında
-- doldurur. Lockdown öncesinde eski client'lar bu kolonu yazmasa da
-- gameplay etkilenmez.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_rooms
  add column if not exists host_player_id uuid null;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_player_claims — özel claim-token deposu
-- ----------------------------------------------------------------------------
-- Token'lar duel_players ile aynı tabloda DURMAZ; eklenirse realtime WAL
-- akışında (duel_players supabase_realtime publication'ında ve REPLICA
-- IDENTITY FULL ile) her aboneye token yayınlanırdı. Ayrı tabloda tutarak:
--   (a) supabase_realtime publication'a eklemiyoruz,
--   (b) SELECT policy hiç eklemiyoruz + SELECT grant'i de geri alıyoruz
--       → token sadece insert eden tarafta bilinir.
--
-- player_id PK ve FK ON DELETE CASCADE → bir player satırı silindiğinde
-- (forfeit, kick, leave_room, room cascade) claim_token de otomatik temizlenir.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.duel_player_claims (
  player_id   uuid        primary key
                          references public.duel_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);

alter table public.duel_player_claims enable row level security;

-- INSERT açık (anon ve authenticated). Misafir bile join sırasında kendi
-- claim'ini bırakabilmeli. UPDATE/DELETE policy YOK → token rotate edilemez,
-- silinemez (player_id cascade ile silindiğinde otomatik temizlenir).
drop policy if exists "duel_player_claims_insert"
  on public.duel_player_claims;

create policy "duel_player_claims_insert"
  on public.duel_player_claims
  for insert
  to anon, authenticated
  with check (true);

-- Defense-in-depth: PostgREST yine de RLS'i uygular, ama SELECT için tablo
-- üstünde grant olmamasını da garanti altına al. (Supabase default tüm public
-- tablolarına anon+authenticated rolüne grant verir; biz select'i geri alıyoruz.)
revoke select, update, delete on public.duel_player_claims from anon, authenticated;
grant  insert                   on public.duel_player_claims to anon, authenticated;

-- NOT: alter publication supabase_realtime ADD TABLE duel_player_claims
-- ÇAĞRILMIYOR. Bu kasıtlı. Token asla broadcast edilmemeli.


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Yetki yardımcıları (read-only, SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Wheel Duel pattern'inin birebir Duel 1v1 karşılığı. M2 RPC'leri bu helper'ları
-- giriş noktası olarak kullanacak; M1 sırasında çağıran yok ama tablo şeması
-- ve grant'lar şimdiden hazır.
--
-- search_path = public, auth → SECURITY DEFINER fonksiyonlarda search_path
-- enjeksiyonunu engellemek için açıkça set ediliyor (Supabase security best
-- practice; wheel_duel/conquest hardening'inde aynısı).
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bir player_id için: caller ya o satırın profile_id = auth.uid() sahibi
--     ya da claim_token eşleşen misafir mi?
create or replace function public.duel_authorize_player(
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
      from public.duel_players p
      left join public.duel_player_claims c
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

revoke all     on function public.duel_authorize_player(uuid, uuid) from public;
grant  execute on function public.duel_authorize_player(uuid, uuid) to anon, authenticated;


-- (b) Verilen oda için: caller, oda host'unun ta kendisi mi?
--     host_player_id eşleşmesi + authorize_player ZORUNLU.
--
-- NOT: host_player_id NULL ise (M1 öncesi açılmış canlı odalar) bu helper
-- her zaman false döner. M2 RPC'leri yeni odalarda host_player_id'yi
-- doldurduğu için yeni akışlarda sorun çıkmaz. Lockdown öncesi cached eski
-- client'lar zaten direkt UPDATE yolunu kullandığı için bu helper'a hiç
-- girmezler.
create or replace function public.duel_authorize_host(
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
      from public.duel_rooms r
     where r.id = p_room_id
       and r.host_player_id = p_player_id
       and public.duel_authorize_player(p_player_id, p_claim_token)
  );
$$;

revoke all     on function public.duel_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.duel_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel olarak Studio SQL editor'de çalıştırılabilir):
--
--   -- Yeni kolonlar var mı?
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'duel_players'
--      and column_name in ('profile_id', 'guest_id');
--   -- Beklenen: 2 satır, ikisi de YES (nullable).
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'duel_rooms'
--      and column_name  = 'host_player_id';
--   -- Beklenen: 1 satır, uuid, YES.
--
--   -- Yeni tablo:
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'duel_player_claims';
--
--   -- Policy yalnız INSERT olmalı:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'duel_player_claims';
--   -- Beklenen: tek satır, cmd=INSERT, roles={anon,authenticated}.
--
--   -- Grant durumu: anon/authenticated sadece INSERT'e sahip olmalı.
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'duel_player_claims'
--    order by grantee, privilege_type;
--   -- Beklenen: anon → INSERT, authenticated → INSERT (SELECT/UPDATE/DELETE yok).
--
--   -- Claim tablosu realtime publication'da OLMAMALI:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename = 'duel_player_claims';
--   -- Beklenen: 0 satır.
--
--   -- Fonksiyonlar (security definer flag'i):
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('duel_authorize_player', 'duel_authorize_host');
--   -- Beklenen: 2 satır, ikisi de prosecdef=true.
--
--   -- Mevcut duel_* RLS politikaları HÂLÂ YERİNDE olmalı (M1 dokunmaz):
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_rooms', 'duel_players', 'duel_claims', 'duel_messages')
--    order by tablename, cmd;
--   -- Beklenen: Studio'da daha önce kurulmuş geniş anon (+ authenticated)
--   --           politikaları olduğu gibi listelensin. M1 hiçbirini düşürmez,
--   --           hiçbirini eklemez.
-- ============================================================================
