-- ============================================================================
-- GÜNÜN GÖREVİ (Daily Quest) — sunucu-otoriter günlük görev sistemi (init)
-- ============================================================================
-- Kapsam:
--   • Her UTC gününde TÜM oyunculara AYNI tek global görev (00:00 UTC sınırı).
--   • 4 mod: country_write (Ülke Yaz) / flag_quiz (Bayrak Bilmece) /
--     route_complete (Rota) / wheel_find (Çark).
--   • Görev seçimi SUNUCUDA, on-demand (cron YOK): geçmişe duyarlı rotasyon —
--     45 gün exact-config cooldown, 2 gün mode cooldown, 45 gün yakın-benzer
--     bloğu, 30 gün zorluk-gerilemesi bloğu, 7→5→0 family cooldown merdiveni,
--     son-7-gün tier dengesi tercihi, md5(date|config_key) deterministik pick.
--     Aday kalmazsa AÇIK hata: 'daily_quest_pool_exhausted' (sessiz tekrar YOK).
--   • Attempt/ilerleme/claim tamamen SECURITY DEFINER RPC'lerde; client
--     tabloların HİÇBİRİNE doğrudan erişemez (grant yok + RLS default-deny).
--   • İçerik (bayrak dizisi / rota çifti / çark hedefleri) kullanıcı başına
--     md5(quest_id:user_id) seed'iyle ÜRETİLİR ve daily_quest_user_content'e
--     YAZILIR → tekrar denemeler içeriği REROLL EDEMEZ.
--   • Ödül: sabit daily_quests.reward_gold (=50); claim idempotent
--     (unique(user_id, daily_quest_id)), gold _apply_gold_delta ile aynı
--     transaction'da yazılır (gold_transactions log'lu). Client miktar
--     GÖNDEREMEZ.
--
-- Rota altyapısı: 20260802120000_route_duel_init.sql'in CANLI route_duel_graph
-- (komşuluk doğrulaması) + route_duel_pool (5/7/8/9 ara ülkeli çiftler)
-- tabloları YENİDEN KULLANILIR; o migration'a DOKUNULMAZ.
--
-- Seed bölümleri (COUNTRY CATALOG + TEMPLATES) codegen çıktısıdır:
--   npx tsx scripts/dailyQuest/build-daily-quest-data.ts
-- Kaynak matris: scripts/dailyQuest/templates.ts (65 config; 17/16/16/16).
-- Seçim kurallarının saf TS aynası: scripts/dailyQuest/selector.ts
-- (check-daily-quest-rotation.ts 90/180/365 gün simülasyonları).
--
-- IDEMPOTENT: create table if not exists / create or replace / on conflict.
-- DEPLOY: migration + client BİRLİKTE deploy edilmeli. DEPLOY EDİLMEDİ.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

-- Canonical ülke kataloğu (src/data/countries.ts codegen'i; yalnız counted).
-- continents[] MULTI_CONTINENT dahil bölge üyeliği (country_write doğrulaması);
-- primary_continent bayrak/çark havuz üyeliği (getFlagPool/getWheelPool aynası).
create table if not exists public.daily_quest_country_catalog (
  code              text primary key,
  topo_id           text not null,
  display           text not null,
  primary_continent text not null,
  continents        text[] not null,
  counted           boolean not null default true,
  wheel_eligible    boolean not null,
  fame_tier         int  not null check (fame_tier between 1 and 4)
);

create table if not exists public.daily_quest_templates (
  id                uuid primary key default gen_random_uuid(),
  configuration_key text not null unique,
  family_key        text not null,
  comparable_key    text not null,
  mode              text not null check (mode in
                      ('country_write','flag_quiz','route_complete','wheel_find')),
  metric            text not null,
  config            jsonb not null,
  difficulty_score  numeric not null,
  difficulty_tier   text not null check (difficulty_tier in ('easy','normal','hard')),
  enabled           boolean not null default true,
  version           int not null default 1,
  title             text not null,
  description       text not null,
  created_at        timestamptz not null default now()
);

create index if not exists daily_quest_templates_mode_idx
  on public.daily_quest_templates (mode) where enabled;

create table if not exists public.daily_quests (
  id          uuid primary key default gen_random_uuid(),
  quest_date  date not null unique,          -- eşzamanlı üretimde tek satır garantisi
  template_id uuid not null references public.daily_quest_templates(id),
  mode        text not null,
  title       text not null,
  description text not null,
  reward_gold int  not null default 50 check (reward_gold > 0 and reward_gold <= 500),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  config      jsonb not null,                -- template config SNAPSHOT'ı
  created_at  timestamptz not null default now()
);

create index if not exists daily_quests_date_idx
  on public.daily_quests (quest_date desc);

-- Kullanıcı-başına görev içeriği (bayrak dizisi / rota çifti / çark hedefleri).
-- İlk attempt'te üretilir, gün boyunca SABİT kalır → reroll engeli.
create table if not exists public.daily_quest_user_content (
  daily_quest_id uuid not null references public.daily_quests(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  content        jsonb not null,
  created_at     timestamptz not null default now(),
  primary key (daily_quest_id, user_id)
);

create table if not exists public.daily_quest_attempts (
  id             uuid primary key default gen_random_uuid(),
  daily_quest_id uuid not null references public.daily_quests(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'active' check (status in
                   ('active','completed','failed','abandoned','expired')),
  -- Mod-özel sunucu ilerlemesi (found[], next_index, current_key, ...).
  progress       jsonb not null default '{}'::jsonb,
  started_at     timestamptz not null default now(),
  deadline       timestamptz not null,
  completed_at   timestamptz null,
  created_at     timestamptz not null default now()
);

-- Aynı kullanıcı + aynı görev için EN FAZLA BİR aktif attempt (iki sekme koruması).
create unique index if not exists daily_quest_attempts_one_active_uq
  on public.daily_quest_attempts (daily_quest_id, user_id)
  where (status = 'active');

create index if not exists daily_quest_attempts_user_quest_idx
  on public.daily_quest_attempts (user_id, daily_quest_id, status);

create table if not exists public.daily_quest_claims (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  daily_quest_id uuid not null references public.daily_quests(id) on delete cascade,
  attempt_id     uuid not null references public.daily_quest_attempts(id) on delete cascade,
  reward_gold    int  not null,
  claimed_at     timestamptz not null default now(),
  -- Aynı kullanıcı aynı günlük ödülü YALNIZ BİR defa alabilir.
  unique (user_id, daily_quest_id)
);


-- ────────────────────────────────────────────────────────────────────────────
-- 2) RLS + client lockdown — tablolar TAMAMEN RPC arkasında
-- ────────────────────────────────────────────────────────────────────────────

alter table public.daily_quest_country_catalog enable row level security;
alter table public.daily_quest_templates       enable row level security;
alter table public.daily_quests                enable row level security;
alter table public.daily_quest_user_content    enable row level security;
alter table public.daily_quest_attempts        enable row level security;
alter table public.daily_quest_claims          enable row level security;

-- Policy tanımlanmadı → RLS default-deny. SECURITY DEFINER fonksiyonları
-- (owner) RLS'i bypass eder. Grant de yok → çifte kilit.
revoke all on table public.daily_quest_country_catalog from anon, authenticated, public;
revoke all on table public.daily_quest_templates       from anon, authenticated, public;
revoke all on table public.daily_quests                from anon, authenticated, public;
revoke all on table public.daily_quest_user_content    from anon, authenticated, public;
revoke all on table public.daily_quest_attempts        from anon, authenticated, public;
revoke all on table public.daily_quest_claims          from anon, authenticated, public;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) SEED — ülke kataloğu (codegen; elle düzenleme)
-- ────────────────────────────────────────────────────────────────────────────
-- BEGIN GENERATED: COUNTRY CATALOG
-- 196 counted ülke (src/data/countries.ts).
insert into public.daily_quest_country_catalog
  (code, topo_id, display, primary_continent, continents, counted, wheel_eligible, fame_tier)
values
  ('al','008','Arnavutluk','europe','{europe}',true,true,2),
  ('ad','020','Andorra','europe','{europe}',true,false,4),
  ('at','040','Avusturya','europe','{europe}',true,true,2),
  ('by','112','Belarus','europe','{europe}',true,true,2),
  ('be','056','Belçika','europe','{europe}',true,true,2),
  ('ba','070','Bosna Hersek','europe','{europe}',true,true,2),
  ('bg','100','Bulgaristan','europe','{europe}',true,true,2),
  ('hr','191','Hırvatistan','europe','{europe}',true,true,2),
  ('cy','196','Kıbrıs','europe','{europe}',true,true,2),
  ('cz','203','Çekya','europe','{europe}',true,true,2),
  ('dk','208','Danimarka','europe','{europe}',true,true,2),
  ('ee','233','Estonya','europe','{europe}',true,true,3),
  ('fi','246','Finlandiya','europe','{europe}',true,true,2),
  ('fr','250','Fransa','europe','{europe}',true,true,1),
  ('de','276','Almanya','europe','{europe}',true,true,1),
  ('gr','300','Yunanistan','europe','{europe}',true,true,1),
  ('hu','348','Macaristan','europe','{europe}',true,true,2),
  ('is','352','İzlanda','europe','{europe}',true,true,2),
  ('ie','372','İrlanda','europe','{europe}',true,true,2),
  ('it','380','İtalya','europe','{europe}',true,true,1),
  ('lv','428','Letonya','europe','{europe}',true,true,2),
  ('li','438','Lihtenştayn','europe','{europe}',true,false,4),
  ('lt','440','Litvanya','europe','{europe}',true,true,2),
  ('lu','442','Lüksemburg','europe','{europe}',true,true,2),
  ('mt','470','Malta','europe','{europe}',true,false,4),
  ('md','498','Moldova','europe','{europe}',true,true,3),
  ('mc','492','Monako','europe','{europe}',true,false,4),
  ('me','499','Karadağ','europe','{europe}',true,true,3),
  ('nl','528','Hollanda','europe','{europe}',true,true,1),
  ('mk','807','Kuzey Makedonya','europe','{europe}',true,true,2),
  ('no','578','Norveç','europe','{europe}',true,true,2),
  ('pl','616','Polonya','europe','{europe}',true,true,2),
  ('pt','620','Portekiz','europe','{europe}',true,true,1),
  ('ro','642','Romanya','europe','{europe}',true,true,2),
  ('ru','643','Rusya','europe','{europe,asia}',true,true,1),
  ('sm','674','San Marino','europe','{europe}',true,false,4),
  ('rs','688','Sırbistan','europe','{europe}',true,true,2),
  ('sk','703','Slovakya','europe','{europe}',true,true,2),
  ('si','705','Slovenya','europe','{europe}',true,true,2),
  ('es','724','İspanya','europe','{europe}',true,true,1),
  ('se','752','İsveç','europe','{europe}',true,true,2),
  ('ch','756','İsviçre','europe','{europe}',true,true,2),
  ('ua','804','Ukrayna','europe','{europe}',true,true,1),
  ('gb','826','Birleşik Krallık','europe','{europe}',true,true,1),
  ('va','336','Vatikan','europe','{europe}',true,false,4),
  ('xk','XK','Kosova','europe','{europe}',true,true,4),
  ('af','004','Afganistan','asia','{asia}',true,true,2),
  ('am','051','Ermenistan','asia','{asia}',true,true,2),
  ('az','031','Azerbaycan','asia','{asia}',true,true,1),
  ('bh','048','Bahreyn','asia','{asia}',true,false,4),
  ('bd','050','Bangladeş','asia','{asia}',true,true,2),
  ('bt','064','Butan','asia','{asia}',true,true,4),
  ('bn','096','Brunei','asia','{asia}',true,false,4),
  ('kh','116','Kamboçya','asia','{asia}',true,true,3),
  ('cn','156','Çin','asia','{asia}',true,true,1),
  ('ge','268','Gürcistan','asia','{asia}',true,true,3),
  ('in','356','Hindistan','asia','{asia}',true,true,1),
  ('id','360','Endonezya','asia','{asia}',true,true,2),
  ('ir','364','İran','asia','{asia}',true,true,1),
  ('iq','368','Irak','asia','{asia}',true,true,1),
  ('il','376','İsrail','asia','{asia}',true,true,2),
  ('jp','392','Japonya','asia','{asia}',true,true,1),
  ('jo','400','Ürdün','asia','{asia}',true,true,3),
  ('kz','398','Kazakistan','asia','{asia}',true,true,2),
  ('kw','414','Kuveyt','asia','{asia}',true,true,2),
  ('kg','417','Kırgızistan','asia','{asia}',true,true,3),
  ('la','418','Laos','asia','{asia}',true,true,3),
  ('lb','422','Lübnan','asia','{asia}',true,true,2),
  ('my','458','Malezya','asia','{asia}',true,true,2),
  ('mv','462','Maldivler','asia','{asia}',true,false,4),
  ('mn','496','Moğolistan','asia','{asia}',true,true,2),
  ('mm','104','Myanmar','asia','{asia}',true,true,2),
  ('np','524','Nepal','asia','{asia}',true,true,2),
  ('kp','408','Kuzey Kore','asia','{asia}',true,true,2),
  ('om','512','Umman','asia','{asia}',true,true,3),
  ('pk','586','Pakistan','asia','{asia}',true,true,2),
  ('ps','275','Filistin','asia','{asia}',true,true,3),
  ('ph','608','Filipinler','asia','{asia}',true,true,2),
  ('qa','634','Katar','asia','{asia}',true,true,3),
  ('sa','682','Suudi Arabistan','asia','{asia}',true,true,1),
  ('sg','702','Singapur','asia','{asia}',true,false,4),
  ('kr','410','Güney Kore','asia','{asia}',true,true,1),
  ('lk','144','Sri Lanka','asia','{asia}',true,true,2),
  ('sy','760','Suriye','asia','{asia}',true,true,2),
  ('tj','762','Tacikistan','asia','{asia}',true,true,3),
  ('th','764','Tayland','asia','{asia}',true,true,2),
  ('tl','626','Doğu Timor','asia','{asia}',true,true,4),
  ('tr','792','Türkiye','asia','{europe,asia}',true,true,1),
  ('tm','795','Türkmenistan','asia','{asia}',true,true,3),
  ('ae','784','BAE','asia','{asia}',true,true,2),
  ('uz','860','Özbekistan','asia','{asia}',true,true,3),
  ('vn','704','Vietnam','asia','{asia}',true,true,2),
  ('ye','887','Yemen','asia','{asia}',true,true,2),
  ('dz','012','Cezayir','africa','{africa}',true,true,2),
  ('ao','024','Angola','africa','{africa}',true,true,2),
  ('bj','204','Benin','africa','{africa}',true,true,4),
  ('bw','072','Botsvana','africa','{africa}',true,true,3),
  ('bf','854','Burkina Faso','africa','{africa}',true,true,4),
  ('bi','108','Burundi','africa','{africa}',true,true,4),
  ('cv','132','Cabo Verde','africa','{africa}',true,false,4),
  ('cm','120','Kamerun','africa','{africa}',true,true,2),
  ('cf','140','Orta Afrika Cumhuriyeti','africa','{africa}',true,true,3),
  ('td','148','Çad','africa','{africa}',true,true,2),
  ('km','174','Komorlar','africa','{africa}',true,false,4),
  ('cg','178','Kongo Cumhuriyeti','africa','{africa}',true,true,3),
  ('cd','180','Kongo DR','africa','{africa}',true,true,2),
  ('ci','384','Fildişi Sahili','africa','{africa}',true,true,2),
  ('dj','262','Cibuti','africa','{africa}',true,true,4),
  ('eg','818','Mısır','africa','{africa}',true,true,1),
  ('gq','226','Ekvator Ginesi','africa','{africa}',true,true,4),
  ('er','232','Eritre','africa','{africa}',true,true,4),
  ('et','231','Etiyopya','africa','{africa}',true,true,2),
  ('ga','266','Gabon','africa','{africa}',true,true,4),
  ('gm','270','Gambiya','africa','{africa}',true,true,4),
  ('gh','288','Gana','africa','{africa}',true,true,2),
  ('gn','324','Gine','africa','{africa}',true,true,4),
  ('gw','624','Gine-Bissau','africa','{africa}',true,true,4),
  ('ke','404','Kenya','africa','{africa}',true,true,2),
  ('ls','426','Lesoto','africa','{africa}',true,true,4),
  ('lr','430','Liberya','africa','{africa}',true,true,4),
  ('ly','434','Libya','africa','{africa}',true,true,2),
  ('mg','450','Madagaskar','africa','{africa}',true,true,2),
  ('mw','454','Malavi','africa','{africa}',true,true,3),
  ('ml','466','Mali','africa','{africa}',true,true,2),
  ('mr','478','Moritanya','africa','{africa}',true,true,4),
  ('mu','480','Mauritius','africa','{africa}',true,false,4),
  ('ma','504','Fas','africa','{africa}',true,true,2),
  ('mz','508','Mozambik','africa','{africa}',true,true,2),
  ('na','516','Namibya','africa','{africa}',true,true,2),
  ('ne','562','Nijer','africa','{africa}',true,true,4),
  ('ng','566','Nijerya','africa','{africa}',true,true,2),
  ('rw','646','Ruanda','africa','{africa}',true,true,2),
  ('st','678','Sao Tome ve Principe','africa','{africa}',true,false,4),
  ('sn','686','Senegal','africa','{africa}',true,true,2),
  ('sc','690','Seyşeller','africa','{africa}',true,false,4),
  ('sl','694','Sierra Leone','africa','{africa}',true,true,4),
  ('so','706','Somali','africa','{africa}',true,true,2),
  ('za','710','Güney Afrika','africa','{africa}',true,true,2),
  ('ss','728','Güney Sudan','africa','{africa}',true,true,2),
  ('sd','729','Sudan','africa','{africa}',true,true,2),
  ('sz','748','Esvatini','africa','{africa}',true,true,4),
  ('tz','834','Tanzanya','africa','{africa}',true,true,2),
  ('tg','768','Togo','africa','{africa}',true,true,4),
  ('tn','788','Tunus','africa','{africa}',true,true,2),
  ('ug','800','Uganda','africa','{africa}',true,true,2),
  ('zm','894','Zambiya','africa','{africa}',true,true,2),
  ('zw','716','Zimbabve','africa','{africa}',true,true,2),
  ('ag','028','Antigua ve Barbuda','north-america','{north-america}',true,false,4),
  ('bs','044','Bahamalar','north-america','{north-america}',true,true,3),
  ('bb','052','Barbados','north-america','{north-america}',true,false,4),
  ('bz','084','Belize','north-america','{north-america}',true,true,4),
  ('ca','124','Kanada','north-america','{north-america}',true,true,1),
  ('cr','188','Kosta Rika','north-america','{north-america}',true,true,3),
  ('cu','192','Küba','north-america','{north-america}',true,true,2),
  ('dm','212','Dominika','north-america','{north-america}',true,false,4),
  ('do','214','Dominik Cumhuriyeti','north-america','{north-america}',true,true,2),
  ('sv','222','El Salvador','north-america','{north-america}',true,true,3),
  ('gd','308','Grenada','north-america','{north-america}',true,false,4),
  ('gt','320','Guatemala','north-america','{north-america}',true,true,2),
  ('ht','332','Haiti','north-america','{north-america}',true,true,2),
  ('hn','340','Honduras','north-america','{north-america}',true,true,2),
  ('jm','388','Jamaika','north-america','{north-america}',true,true,3),
  ('mx','484','Meksika','north-america','{north-america}',true,true,1),
  ('ni','558','Nikaragua','north-america','{north-america}',true,true,3),
  ('pa','591','Panama','north-america','{north-america}',true,true,2),
  ('kn','659','Saint Kitts ve Nevis','north-america','{north-america}',true,false,4),
  ('lc','662','Saint Lucia','north-america','{north-america}',true,false,4),
  ('vc','670','Saint Vincent ve Grenadinler','north-america','{north-america}',true,false,4),
  ('tt','780','Trinidad ve Tobago','north-america','{north-america}',true,true,3),
  ('us','840','ABD','north-america','{north-america}',true,true,1),
  ('ar','032','Arjantin','south-america','{south-america}',true,true,1),
  ('bo','068','Bolivya','south-america','{south-america}',true,true,3),
  ('br','076','Brezilya','south-america','{south-america}',true,true,1),
  ('cl','152','Şili','south-america','{south-america}',true,true,2),
  ('co','170','Kolombiya','south-america','{south-america}',true,true,2),
  ('ec','218','Ekvador','south-america','{south-america}',true,true,2),
  ('gy','328','Guyana','south-america','{south-america}',true,true,4),
  ('py','600','Paraguay','south-america','{south-america}',true,true,4),
  ('pe','604','Peru','south-america','{south-america}',true,true,2),
  ('sr','740','Surinam','south-america','{south-america}',true,true,4),
  ('uy','858','Uruguay','south-america','{south-america}',true,true,4),
  ('ve','862','Venezuela','south-america','{south-america}',true,true,2),
  ('au','036','Avustralya','oceania','{oceania}',true,true,1),
  ('fj','242','Fiji','oceania','{oceania}',true,false,4),
  ('ki','296','Kiribati','oceania','{oceania}',true,false,4),
  ('mh','584','Marshall Adaları','oceania','{oceania}',true,false,4),
  ('fm','583','Mikronezya','oceania','{oceania}',true,false,4),
  ('nr','520','Nauru','oceania','{oceania}',true,false,4),
  ('nz','554','Yeni Zelanda','oceania','{oceania}',true,true,2),
  ('pw','585','Palau','oceania','{oceania}',true,false,4),
  ('pg','598','Papua Yeni Gine','oceania','{oceania}',true,true,3),
  ('ws','882','Samoa','oceania','{oceania}',true,false,4),
  ('sb','090','Solomon Adaları','oceania','{oceania}',true,true,4),
  ('to','776','Tonga','oceania','{oceania}',true,false,4),
  ('tv','798','Tuvalu','oceania','{oceania}',true,false,4),
  ('vu','548','Vanuatu','oceania','{oceania}',true,true,4)
on conflict (code) do update set
  topo_id           = excluded.topo_id,
  display           = excluded.display,
  primary_continent = excluded.primary_continent,
  continents        = excluded.continents,
  counted           = excluded.counted,
  wheel_eligible    = excluded.wheel_eligible,
  fame_tier         = excluded.fame_tier;
-- END GENERATED: COUNTRY CATALOG


-- ────────────────────────────────────────────────────────────────────────────
-- 4) SEED — görev şablonları (codegen; elle düzenleme)
-- ────────────────────────────────────────────────────────────────────────────
-- BEGIN GENERATED: TEMPLATES
-- 65 config (country_write 17 / flag_quiz 16 / route_complete 16 / wheel_find 16) — scripts/dailyQuest/templates.ts.
insert into public.daily_quest_templates
  (configuration_key, family_key, comparable_key, mode, metric, config,
   difficulty_score, difficulty_tier, enabled, version, title, description)
values
  ('country_write|world|60|10', 'country_write|world|60', 'country_write|world|60', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":60,"target_count":10}'::jsonb, 105, 'easy', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 1 dakika içinde 10 farklı ülke yaz.'),
  ('country_write|world|60|14', 'country_write|world|60', 'country_write|world|60', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":60,"target_count":14}'::jsonb, 147, 'normal', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 1 dakika içinde 14 farklı ülke yaz.'),
  ('country_write|world|60|18', 'country_write|world|60', 'country_write|world|60', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":60,"target_count":18}'::jsonb, 189, 'hard', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 1 dakika içinde 18 farklı ülke yaz.'),
  ('country_write|world|120|16', 'country_write|world|120', 'country_write|world|120', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":120,"target_count":16}'::jsonb, 88, 'easy', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 2 dakika içinde 16 farklı ülke yaz.'),
  ('country_write|world|120|20', 'country_write|world|120', 'country_write|world|120', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":120,"target_count":20}'::jsonb, 110, 'normal', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 2 dakika içinde 20 farklı ülke yaz.'),
  ('country_write|world|120|26', 'country_write|world|120', 'country_write|world|120', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":120,"target_count":26}'::jsonb, 143, 'hard', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 2 dakika içinde 26 farklı ülke yaz.'),
  ('country_write|world|180|24', 'country_write|world|180', 'country_write|world|180', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":180,"target_count":24}'::jsonb, 92, 'normal', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 3 dakika içinde 24 farklı ülke yaz.'),
  ('country_write|world|180|30', 'country_write|world|180', 'country_write|world|180', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":180,"target_count":30}'::jsonb, 115, 'hard', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 3 dakika içinde 30 farklı ülke yaz.'),
  ('country_write|world|300|40', 'country_write|world|300', 'country_write|world|300', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":300,"target_count":40}'::jsonb, 100, 'normal', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 5 dakika içinde 40 farklı ülke yaz.'),
  ('country_write|world|300|50', 'country_write|world|300', 'country_write|world|300', 'country_write', 'unique_countries', '{"region":"world","duration_seconds":300,"target_count":50}'::jsonb, 125, 'hard', true, 1, 'Ülke Yaz: Dünya', 'Dünya kategorisinde 5 dakika içinde 50 farklı ülke yaz.'),
  ('country_write|europe|60|8', 'country_write|europe|60', 'country_write|europe|60', 'country_write', 'unique_countries', '{"region":"europe","duration_seconds":60,"target_count":8}'::jsonb, 92, 'easy', true, 1, 'Ülke Yaz: Avrupa', 'Avrupa kategorisinde 1 dakika içinde 8 farklı ülke yaz.'),
  ('country_write|europe|60|12', 'country_write|europe|60', 'country_write|europe|60', 'country_write', 'unique_countries', '{"region":"europe","duration_seconds":60,"target_count":12}'::jsonb, 138, 'normal', true, 1, 'Ülke Yaz: Avrupa', 'Avrupa kategorisinde 1 dakika içinde 12 farklı ülke yaz.'),
  ('country_write|europe|60|16', 'country_write|europe|60', 'country_write|europe|60', 'country_write', 'unique_countries', '{"region":"europe","duration_seconds":60,"target_count":16}'::jsonb, 184, 'hard', true, 1, 'Ülke Yaz: Avrupa', 'Avrupa kategorisinde 1 dakika içinde 16 farklı ülke yaz.'),
  ('country_write|europe|120|20', 'country_write|europe|120', 'country_write|europe|120', 'country_write', 'unique_countries', '{"region":"europe","duration_seconds":120,"target_count":20}'::jsonb, 120, 'normal', true, 1, 'Ülke Yaz: Avrupa', 'Avrupa kategorisinde 2 dakika içinde 20 farklı ülke yaz.'),
  ('country_write|asia|60|8', 'country_write|asia|60', 'country_write|asia|60', 'country_write', 'unique_countries', '{"region":"asia","duration_seconds":60,"target_count":8}'::jsonb, 96, 'easy', true, 1, 'Ülke Yaz: Asya', 'Asya kategorisinde 1 dakika içinde 8 farklı ülke yaz.'),
  ('country_write|asia|120|16', 'country_write|asia|120', 'country_write|asia|120', 'country_write', 'unique_countries', '{"region":"asia","duration_seconds":120,"target_count":16}'::jsonb, 100, 'normal', true, 1, 'Ülke Yaz: Asya', 'Asya kategorisinde 2 dakika içinde 16 farklı ülke yaz.'),
  ('country_write|africa|120|18', 'country_write|africa|120', 'country_write|africa|120', 'country_write', 'unique_countries', '{"region":"africa","duration_seconds":120,"target_count":18}'::jsonb, 126, 'normal', true, 1, 'Ülke Yaz: Afrika', 'Afrika kategorisinde 2 dakika içinde 18 farklı ülke yaz.'),
  ('flag_quiz|world|8|5', 'flag_quiz|world|8', 'flag_quiz|world|8', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":8,"required_correct":5,"window_seconds":230}'::jsonb, 7.9, 'easy', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 8 bayrak göreceksin; en az 5 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|8|7', 'flag_quiz|world|8', 'flag_quiz|world|8', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":8,"required_correct":7,"window_seconds":230}'::jsonb, 10.4, 'hard', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 8 bayrak göreceksin; en az 7 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|10|7', 'flag_quiz|world|10', 'flag_quiz|world|10', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":10,"required_correct":7,"window_seconds":280}'::jsonb, 9, 'easy', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 10 bayrak göreceksin; en az 7 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|10|9', 'flag_quiz|world|10', 'flag_quiz|world|10', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":10,"required_correct":9,"window_seconds":280}'::jsonb, 11, 'hard', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 10 bayrak göreceksin; en az 9 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|12|8', 'flag_quiz|world|12', 'flag_quiz|world|12', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":12,"required_correct":8,"window_seconds":330}'::jsonb, 9.1, 'easy', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 12 bayrak göreceksin; en az 8 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|12|10', 'flag_quiz|world|12', 'flag_quiz|world|12', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":12,"required_correct":10,"window_seconds":330}'::jsonb, 10.7, 'normal', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 12 bayrak göreceksin; en az 10 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|15|11', 'flag_quiz|world|15', 'flag_quiz|world|15', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":15,"required_correct":11,"window_seconds":405}'::jsonb, 10.3, 'normal', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 15 bayrak göreceksin; en az 11 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|15|13', 'flag_quiz|world|15', 'flag_quiz|world|15', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":15,"required_correct":13,"window_seconds":405}'::jsonb, 11.7, 'hard', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 15 bayrak göreceksin; en az 13 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|20|14', 'flag_quiz|world|20', 'flag_quiz|world|20', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":20,"required_correct":14,"window_seconds":530}'::jsonb, 11, 'normal', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 20 bayrak göreceksin; en az 14 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|world|20|17', 'flag_quiz|world|20', 'flag_quiz|world|20', 'flag_quiz', 'correct_flags', '{"region":"world","total_questions":20,"required_correct":17,"window_seconds":530}'::jsonb, 12.5, 'hard', true, 1, 'Bayrak Bilmece: Dünya', 'Dünya kategorisinde 20 bayrak göreceksin; en az 17 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|europe|10|8', 'flag_quiz|europe|10', 'flag_quiz|europe|10', 'flag_quiz', 'correct_flags', '{"region":"europe","total_questions":10,"required_correct":8,"window_seconds":280}'::jsonb, 9.6, 'normal', true, 1, 'Bayrak Bilmece: Avrupa', 'Avrupa kategorisinde 10 bayrak göreceksin; en az 8 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|europe|12|9', 'flag_quiz|europe|12', 'flag_quiz|europe|12', 'flag_quiz', 'correct_flags', '{"region":"europe","total_questions":12,"required_correct":9,"window_seconds":330}'::jsonb, 9.5, 'normal', true, 1, 'Bayrak Bilmece: Avrupa', 'Avrupa kategorisinde 12 bayrak göreceksin; en az 9 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|asia|10|8', 'flag_quiz|asia|10', 'flag_quiz|asia|10', 'flag_quiz', 'correct_flags', '{"region":"asia","total_questions":10,"required_correct":8,"window_seconds":280}'::jsonb, 11.2, 'normal', true, 1, 'Bayrak Bilmece: Asya', 'Asya kategorisinde 10 bayrak göreceksin; en az 8 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|africa|10|7', 'flag_quiz|africa|10', 'flag_quiz|africa|10', 'flag_quiz', 'correct_flags', '{"region":"africa","total_questions":10,"required_correct":7,"window_seconds":280}'::jsonb, 11.5, 'normal', true, 1, 'Bayrak Bilmece: Afrika', 'Afrika kategorisinde 10 bayrak göreceksin; en az 7 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|africa|12|9', 'flag_quiz|africa|12', 'flag_quiz|africa|12', 'flag_quiz', 'correct_flags', '{"region":"africa","total_questions":12,"required_correct":9,"window_seconds":330}'::jsonb, 12.5, 'hard', true, 1, 'Bayrak Bilmece: Afrika', 'Afrika kategorisinde 12 bayrak göreceksin; en az 9 tanesini doğru bilmen gerekiyor.'),
  ('flag_quiz|south-america|10|8', 'flag_quiz|south-america|10', 'flag_quiz|south-america|10', 'flag_quiz', 'correct_flags', '{"region":"south-america","total_questions":10,"required_correct":8,"window_seconds":280}'::jsonb, 10.4, 'easy', true, 1, 'Bayrak Bilmece: Güney Amerika', 'Güney Amerika kategorisinde 10 bayrak göreceksin; en az 8 tanesini doğru bilmen gerekiyor.'),
  ('route_complete|5|195', 'route_complete|5', 'route_complete|5', 'route_complete', 'route_completed', '{"intermediates":5,"deadline_seconds":195}'::jsonb, 71, 'easy', true, 1, 'Rota Modu: 5 ara ülke', 'Başlangıç ülkesinden hedefe 5 ara ülkeli rotayı 3 dakika 15 saniye içinde tamamla.'),
  ('route_complete|5|150', 'route_complete|5', 'route_complete|5', 'route_complete', 'route_completed', '{"intermediates":5,"deadline_seconds":150}'::jsonb, 80, 'easy', true, 1, 'Rota Modu: 5 ara ülke', 'Başlangıç ülkesinden hedefe 5 ara ülkeli rotayı 2 dakika 30 saniye içinde tamamla.'),
  ('route_complete|5|105', 'route_complete|5', 'route_complete|5', 'route_complete', 'route_completed', '{"intermediates":5,"deadline_seconds":105}'::jsonb, 89, 'normal', true, 1, 'Rota Modu: 5 ara ülke', 'Başlangıç ülkesinden hedefe 5 ara ülkeli rotayı 1 dakika 45 saniye içinde tamamla.'),
  ('route_complete|5|75', 'route_complete|5', 'route_complete|5', 'route_complete', 'route_completed', '{"intermediates":5,"deadline_seconds":75}'::jsonb, 95, 'hard', true, 1, 'Rota Modu: 5 ara ülke', 'Başlangıç ülkesinden hedefe 5 ara ülkeli rotayı 1 dakika 15 saniye içinde tamamla.'),
  ('route_complete|7|225', 'route_complete|7', 'route_complete|7', 'route_complete', 'route_completed', '{"intermediates":7,"deadline_seconds":225}'::jsonb, 85, 'easy', true, 1, 'Rota Modu: 7 ara ülke', 'Başlangıç ülkesinden hedefe 7 ara ülkeli rotayı 3 dakika 45 saniye içinde tamamla.'),
  ('route_complete|7|180', 'route_complete|7', 'route_complete|7', 'route_complete', 'route_completed', '{"intermediates":7,"deadline_seconds":180}'::jsonb, 94, 'normal', true, 1, 'Rota Modu: 7 ara ülke', 'Başlangıç ülkesinden hedefe 7 ara ülkeli rotayı 3 dakika içinde tamamla.'),
  ('route_complete|7|135', 'route_complete|7', 'route_complete|7', 'route_complete', 'route_completed', '{"intermediates":7,"deadline_seconds":135}'::jsonb, 103, 'normal', true, 1, 'Rota Modu: 7 ara ülke', 'Başlangıç ülkesinden hedefe 7 ara ülkeli rotayı 2 dakika 15 saniye içinde tamamla.'),
  ('route_complete|7|100', 'route_complete|7', 'route_complete|7', 'route_complete', 'route_completed', '{"intermediates":7,"deadline_seconds":100}'::jsonb, 110, 'hard', true, 1, 'Rota Modu: 7 ara ülke', 'Başlangıç ülkesinden hedefe 7 ara ülkeli rotayı 1 dakika 40 saniye içinde tamamla.'),
  ('route_complete|8|255', 'route_complete|8', 'route_complete|8', 'route_complete', 'route_completed', '{"intermediates":8,"deadline_seconds":255}'::jsonb, 89, 'easy', true, 1, 'Rota Modu: 8 ara ülke', 'Başlangıç ülkesinden hedefe 8 ara ülkeli rotayı 4 dakika 15 saniye içinde tamamla.'),
  ('route_complete|8|210', 'route_complete|8', 'route_complete|8', 'route_complete', 'route_completed', '{"intermediates":8,"deadline_seconds":210}'::jsonb, 98, 'normal', true, 1, 'Rota Modu: 8 ara ülke', 'Başlangıç ülkesinden hedefe 8 ara ülkeli rotayı 3 dakika 30 saniye içinde tamamla.'),
  ('route_complete|8|160', 'route_complete|8', 'route_complete|8', 'route_complete', 'route_completed', '{"intermediates":8,"deadline_seconds":160}'::jsonb, 108, 'normal', true, 1, 'Rota Modu: 8 ara ülke', 'Başlangıç ülkesinden hedefe 8 ara ülkeli rotayı 2 dakika 40 saniye içinde tamamla.'),
  ('route_complete|8|120', 'route_complete|8', 'route_complete|8', 'route_complete', 'route_completed', '{"intermediates":8,"deadline_seconds":120}'::jsonb, 116, 'hard', true, 1, 'Rota Modu: 8 ara ülke', 'Başlangıç ülkesinden hedefe 8 ara ülkeli rotayı 2 dakika içinde tamamla.'),
  ('route_complete|9|285', 'route_complete|9', 'route_complete|9', 'route_complete', 'route_completed', '{"intermediates":9,"deadline_seconds":285}'::jsonb, 93, 'easy', true, 1, 'Rota Modu: 9 ara ülke', 'Başlangıç ülkesinden hedefe 9 ara ülkeli rotayı 4 dakika 45 saniye içinde tamamla.'),
  ('route_complete|9|240', 'route_complete|9', 'route_complete|9', 'route_complete', 'route_completed', '{"intermediates":9,"deadline_seconds":240}'::jsonb, 102, 'normal', true, 1, 'Rota Modu: 9 ara ülke', 'Başlangıç ülkesinden hedefe 9 ara ülkeli rotayı 4 dakika içinde tamamla.'),
  ('route_complete|9|185', 'route_complete|9', 'route_complete|9', 'route_complete', 'route_completed', '{"intermediates":9,"deadline_seconds":185}'::jsonb, 113, 'hard', true, 1, 'Rota Modu: 9 ara ülke', 'Başlangıç ülkesinden hedefe 9 ara ülkeli rotayı 3 dakika 5 saniye içinde tamamla.'),
  ('route_complete|9|140', 'route_complete|9', 'route_complete|9', 'route_complete', 'route_completed', '{"intermediates":9,"deadline_seconds":140}'::jsonb, 122, 'hard', true, 1, 'Rota Modu: 9 ara ülke', 'Başlangıç ülkesinden hedefe 9 ara ülkeli rotayı 2 dakika 20 saniye içinde tamamla.'),
  ('wheel_find|world|3|60', 'wheel_find|world|3', 'wheel_find|world|3', 'wheel_find', 'targets_found', '{"region":"world","target_count":3,"total_seconds":60}'::jsonb, 60, 'easy', true, 1, 'Çark Modu: 3 hedef', 'Çarkın seçtiği 3 ülkeyi haritada toplam 1 dakika içinde bul.'),
  ('wheel_find|world|3|42', 'wheel_find|world|3', 'wheel_find|world|3', 'wheel_find', 'targets_found', '{"region":"world","target_count":3,"total_seconds":42}'::jsonb, 69, 'normal', true, 1, 'Çark Modu: 3 hedef', 'Çarkın seçtiği 3 ülkeyi haritada toplam 42 saniye içinde bul.'),
  ('wheel_find|world|3|30', 'wheel_find|world|3', 'wheel_find|world|3', 'wheel_find', 'targets_found', '{"region":"world","target_count":3,"total_seconds":30}'::jsonb, 75, 'hard', true, 1, 'Çark Modu: 3 hedef', 'Çarkın seçtiği 3 ülkeyi haritada toplam 30 saniye içinde bul.'),
  ('wheel_find|world|4|75', 'wheel_find|world|4', 'wheel_find|world|4', 'wheel_find', 'targets_found', '{"region":"world","target_count":4,"total_seconds":75}'::jsonb, 62.5, 'easy', true, 1, 'Çark Modu: 4 hedef', 'Çarkın seçtiği 4 ülkeyi haritada toplam 1 dakika 15 saniye içinde bul.'),
  ('wheel_find|world|4|54', 'wheel_find|world|4', 'wheel_find|world|4', 'wheel_find', 'targets_found', '{"region":"world","target_count":4,"total_seconds":54}'::jsonb, 73, 'normal', true, 1, 'Çark Modu: 4 hedef', 'Çarkın seçtiği 4 ülkeyi haritada toplam 54 saniye içinde bul.'),
  ('wheel_find|world|4|40', 'wheel_find|world|4', 'wheel_find|world|4', 'wheel_find', 'targets_found', '{"region":"world","target_count":4,"total_seconds":40}'::jsonb, 80, 'hard', true, 1, 'Çark Modu: 4 hedef', 'Çarkın seçtiği 4 ülkeyi haritada toplam 40 saniye içinde bul.'),
  ('wheel_find|world|5|90', 'wheel_find|world|5', 'wheel_find|world|5', 'wheel_find', 'targets_found', '{"region":"world","target_count":5,"total_seconds":90}'::jsonb, 65, 'easy', true, 1, 'Çark Modu: 5 hedef', 'Çarkın seçtiği 5 ülkeyi haritada toplam 1 dakika 30 saniye içinde bul.'),
  ('wheel_find|world|5|66', 'wheel_find|world|5', 'wheel_find|world|5', 'wheel_find', 'targets_found', '{"region":"world","target_count":5,"total_seconds":66}'::jsonb, 77, 'normal', true, 1, 'Çark Modu: 5 hedef', 'Çarkın seçtiği 5 ülkeyi haritada toplam 1 dakika 6 saniye içinde bul.'),
  ('wheel_find|world|5|50', 'wheel_find|world|5', 'wheel_find|world|5', 'wheel_find', 'targets_found', '{"region":"world","target_count":5,"total_seconds":50}'::jsonb, 85, 'hard', true, 1, 'Çark Modu: 5 hedef', 'Çarkın seçtiği 5 ülkeyi haritada toplam 50 saniye içinde bul.'),
  ('wheel_find|world|6|105', 'wheel_find|world|6', 'wheel_find|world|6', 'wheel_find', 'targets_found', '{"region":"world","target_count":6,"total_seconds":105}'::jsonb, 67.5, 'easy', true, 1, 'Çark Modu: 6 hedef', 'Çarkın seçtiği 6 ülkeyi haritada toplam 1 dakika 45 saniye içinde bul.'),
  ('wheel_find|world|6|78', 'wheel_find|world|6', 'wheel_find|world|6', 'wheel_find', 'targets_found', '{"region":"world","target_count":6,"total_seconds":78}'::jsonb, 81, 'normal', true, 1, 'Çark Modu: 6 hedef', 'Çarkın seçtiği 6 ülkeyi haritada toplam 1 dakika 18 saniye içinde bul.'),
  ('wheel_find|world|6|60', 'wheel_find|world|6', 'wheel_find|world|6', 'wheel_find', 'targets_found', '{"region":"world","target_count":6,"total_seconds":60}'::jsonb, 90, 'hard', true, 1, 'Çark Modu: 6 hedef', 'Çarkın seçtiği 6 ülkeyi haritada toplam 1 dakika içinde bul.'),
  ('wheel_find|europe|3|30', 'wheel_find|europe|3', 'wheel_find|europe|3', 'wheel_find', 'targets_found', '{"region":"europe","target_count":3,"total_seconds":30}'::jsonb, 63.8, 'normal', true, 1, 'Çark Modu: 3 hedef (Avrupa)', 'Çarkın seçtiği 3 ülkeyi haritada toplam 30 saniye içinde bul — yalnız Avrupa haritasında.'),
  ('wheel_find|europe|4|40', 'wheel_find|europe|4', 'wheel_find|europe|4', 'wheel_find', 'targets_found', '{"region":"europe","target_count":4,"total_seconds":40}'::jsonb, 68, 'normal', true, 1, 'Çark Modu: 4 hedef (Avrupa)', 'Çarkın seçtiği 4 ülkeyi haritada toplam 40 saniye içinde bul — yalnız Avrupa haritasında.'),
  ('wheel_find|europe|5|50', 'wheel_find|europe|5', 'wheel_find|europe|5', 'wheel_find', 'targets_found', '{"region":"europe","target_count":5,"total_seconds":50}'::jsonb, 72.3, 'normal', true, 1, 'Çark Modu: 5 hedef (Avrupa)', 'Çarkın seçtiği 5 ülkeyi haritada toplam 50 saniye içinde bul — yalnız Avrupa haritasında.'),
  ('wheel_find|europe|6|60', 'wheel_find|europe|6', 'wheel_find|europe|6', 'wheel_find', 'targets_found', '{"region":"europe","target_count":6,"total_seconds":60}'::jsonb, 76.5, 'normal', true, 1, 'Çark Modu: 6 hedef (Avrupa)', 'Çarkın seçtiği 6 ülkeyi haritada toplam 1 dakika içinde bul — yalnız Avrupa haritasında.')
on conflict (configuration_key) do update set
  family_key       = excluded.family_key,
  comparable_key   = excluded.comparable_key,
  mode             = excluded.mode,
  metric           = excluded.metric,
  config           = excluded.config,
  difficulty_score = excluded.difficulty_score,
  difficulty_tier  = excluded.difficulty_tier,
  enabled          = excluded.enabled,
  version          = excluded.version,
  title            = excluded.title,
  description      = excluded.description;
-- END GENERATED: TEMPLATES


-- ────────────────────────────────────────────────────────────────────────────
-- 5) İÇ yardımcılar — benzerlik + seçim (client'a GRANT YOK)
-- ────────────────────────────────────────────────────────────────────────────

-- Comparable ekseni üzerindeki skaler değer (selector.ts similarityValue aynası).
create or replace function public._daily_quest_similarity_value(
  p_mode text, p_config jsonb
) returns numeric
language sql immutable
as $$
  select case p_mode
    when 'country_write'  then (p_config->>'target_count')::numeric
    when 'flag_quiz'      then (p_config->>'required_correct')::numeric
    when 'route_complete' then (p_config->>'deadline_seconds')::numeric
    when 'wheel_find'     then (p_config->>'total_seconds')::numeric
  end
$$;
revoke all on function public._daily_quest_similarity_value(text, jsonb)
  from public, anon, authenticated;

-- Mod başına yakın-benzerlik eşiği (selector.ts NEAR_SIMILAR_THRESHOLDS aynası).
create or replace function public._daily_quest_similarity_threshold(p_mode text)
returns numeric
language sql immutable
as $$
  select case p_mode
    when 'country_write'  then 2
    when 'flag_quiz'      then 1
    when 'route_complete' then 15
    when 'wheel_find'     then 5
  end::numeric
$$;
revoke all on function public._daily_quest_similarity_threshold(text)
  from public, anon, authenticated;

-- Günün şablonunu seçer (selector.ts selectDailyQuest BİREBİR aynası).
-- Aday kalmazsa 'daily_quest_pool_exhausted' exception (sessiz tekrar YOK).
create or replace function public._daily_quest_select_template(p_date date)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_blocked_modes  text[];
  v_family_window  int;
  v_candidates     uuid[];
  v_tier           text;
  v_tier_pool      uuid[];
  v_pick           uuid;
begin
  -- H2: aynı mode önceki 2 UTC gün içinde tekrar seçilemez.
  select coalesce(array_agg(distinct q.mode), '{}'::text[])
    into v_blocked_modes
    from public.daily_quests q
   where q.quest_date >= p_date - 2
     and q.quest_date <  p_date;

  -- SERT filtreler (H1 exact 45g + H2 mode + H3 yakın-benzer 45g + H4 regresyon 30g),
  -- ardından S1 family merdiveni: 7 → 5 → 0 gün.
  foreach v_family_window in array array[7, 5, 0] loop
    select coalesce(array_agg(t.id), '{}'::uuid[])
      into v_candidates
      from public.daily_quest_templates t
     where t.enabled
       -- H1: aynı configuration_key son 45 UTC gün içinde tekrar seçilemez.
       and not exists (
         select 1 from public.daily_quests q
          where q.template_id = t.id
            and q.quest_date >= p_date - 45
            and q.quest_date <  p_date
       )
       -- H2
       and not (t.mode = any(v_blocked_modes))
       -- H3: yakın-benzer config son 45 günde exact tekrar gibi bloklar.
       and not exists (
         select 1
           from public.daily_quests q
           join public.daily_quest_templates ht on ht.id = q.template_id
          where q.quest_date >= p_date - 45
            and q.quest_date <  p_date
            and ht.id <> t.id
            and ht.mode = t.mode
            and ht.comparable_key = t.comparable_key
            and abs(
                  public._daily_quest_similarity_value(t.mode, t.config)
                - public._daily_quest_similarity_value(ht.mode, ht.config)
                ) <= public._daily_quest_similarity_threshold(t.mode)
       )
       -- H4: aynı comparable_key son 30 günde kullanıldıysa skor GERİLEYEMEZ.
       and not exists (
         select 1
           from public.daily_quests q
           join public.daily_quest_templates ht on ht.id = q.template_id
          where q.quest_date >= p_date - 30
            and q.quest_date <  p_date
            and ht.comparable_key = t.comparable_key
            and t.difficulty_score < ht.difficulty_score
       )
       -- S1: family cooldown (bu turun penceresi).
       and not exists (
         select 1
           from public.daily_quests q
           join public.daily_quest_templates ht on ht.id = q.template_id
          where q.quest_date >= p_date - v_family_window
            and q.quest_date <  p_date
            and ht.family_key = t.family_key
       );
    exit when coalesce(array_length(v_candidates, 1), 0) > 0;
  end loop;

  if coalesce(array_length(v_candidates, 1), 0) = 0 then
    raise exception 'daily_quest_pool_exhausted' using errcode = 'P0001';
  end if;

  -- S2: son 7 günde EN AZ kullanılan tier tercih edilir (deterministik sıra:
  -- sayı eşitse easy → normal → hard). O tier'da aday yoksa sıradaki.
  for v_tier in
    with recent as (
      select ht.difficulty_tier
        from public.daily_quests q
        join public.daily_quest_templates ht on ht.id = q.template_id
       where q.quest_date >= p_date - 7
         and q.quest_date <  p_date
    )
    select tiers.tier
      from (values ('easy', 0), ('normal', 1), ('hard', 2)) as tiers(tier, ord)
      left join (select difficulty_tier, count(*) as n from recent group by 1) c
        on c.difficulty_tier = tiers.tier
     order by coalesce(c.n, 0) asc, tiers.ord asc
  loop
    select coalesce(array_agg(t.id), '{}'::uuid[])
      into v_tier_pool
      from public.daily_quest_templates t
     where t.id = any(v_candidates)
       and t.difficulty_tier = v_tier;
    if coalesce(array_length(v_tier_pool, 1), 0) > 0 then
      v_candidates := v_tier_pool;
      exit;
    end if;
  end loop;

  -- Deterministik pick: md5(quest_date|configuration_key) sözlük-min.
  select t.id
    into v_pick
    from public.daily_quest_templates t
   where t.id = any(v_candidates)
   order by md5(p_date::text || '|' || t.configuration_key) asc
   limit 1;

  return v_pick;
end
$fn$;
revoke all on function public._daily_quest_select_template(date)
  from public, anon, authenticated;

-- Günün görevini döndürür; yoksa transaction + advisory lock + unique(quest_date)
-- korumasıyla OLUŞTURUR (on-demand, cron yok; eşzamanlı ikinci istek aynı satırı alır).
create or replace function public._daily_quest_get_or_create(p_date date)
returns public.daily_quests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_quest    public.daily_quests;
  v_template public.daily_quest_templates;
begin
  select * into v_quest from public.daily_quests where quest_date = p_date;
  if found then return v_quest; end if;

  -- Aynı günü üretmeye çalışan eşzamanlı istekleri serileştir.
  perform pg_advisory_xact_lock(hashtextextended('daily_quest_create:' || p_date::text, 0));

  select * into v_quest from public.daily_quests where quest_date = p_date;
  if found then return v_quest; end if;

  select * into v_template
    from public.daily_quest_templates
   where id = public._daily_quest_select_template(p_date);

  insert into public.daily_quests
    (quest_date, template_id, mode, title, description, reward_gold,
     starts_at, ends_at, config)
  values
    (p_date, v_template.id, v_template.mode, v_template.title,
     v_template.description, 50,
     (p_date::timestamp at time zone 'UTC'),
     ((p_date + 1)::timestamp at time zone 'UTC'),
     v_template.config)
  on conflict (quest_date) do nothing;

  select * into v_quest from public.daily_quests where quest_date = p_date;
  return v_quest;
end
$fn$;
revoke all on function public._daily_quest_get_or_create(date)
  from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) İÇ yardımcılar — kullanıcı içeriği (seed'li, reroll'a kapalı)
-- ────────────────────────────────────────────────────────────────────────────

-- Bölge + (opsiyonel çark uygunluğu) havuzundan, kullanıcı seed'iyle
-- deterministik, kolaydan-zora rampalı N ülke kodu dizisi üretir.
-- Rampa kotaları solo progression eğrisinin aynası: ~%40 T1, %30 T2, %20 T3,
-- kalan T4; stok yetmezse (fame_tier, hash) sırasıyla üstten tamamlanır.
create or replace function public._daily_quest_pick_codes(
  p_seed   text,
  p_region text,
  p_wheel  boolean,
  p_count  int
) returns text[]
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_out       text[] := '{}';
  v_tier      int;
  v_quota     int;
  v_remaining int := p_count;
  v_batch     text[];
begin
  for v_tier in 1..4 loop
    v_quota := case v_tier
      when 1 then ceil(p_count * 0.4)::int
      when 2 then ceil(p_count * 0.3)::int
      when 3 then ceil(p_count * 0.2)::int
      else v_remaining
    end;
    v_quota := least(v_quota, v_remaining);
    exit when v_remaining <= 0;
    if v_quota <= 0 then continue; end if;

    select coalesce(array_agg(code order by h), '{}'::text[])
      into v_batch
      from (
        select c.code, md5(p_seed || ':' || c.code) as h
          from public.daily_quest_country_catalog c
         where c.counted
           and (p_region = 'world' or c.primary_continent = p_region)
           and (not p_wheel or c.wheel_eligible)
           and c.fame_tier = v_tier
           and not (c.code = any(v_out))
         order by h
         limit v_quota
      ) s;
    v_out := v_out || v_batch;
    v_remaining := p_count - coalesce(array_length(v_out, 1), 0);
  end loop;

  -- Stok kotaları dolduramadıysa kalan yerleri havuzun tamamından doldur.
  if v_remaining > 0 then
    select coalesce(array_agg(code order by fame_tier, h), '{}'::text[])
      into v_batch
      from (
        select c.code, c.fame_tier, md5(p_seed || ':' || c.code) as h
          from public.daily_quest_country_catalog c
         where c.counted
           and (p_region = 'world' or c.primary_continent = p_region)
           and (not p_wheel or c.wheel_eligible)
           and not (c.code = any(v_out))
         order by c.fame_tier, h
         limit v_remaining
      ) s;
    v_out := v_out || v_batch;
  end if;

  if coalesce(array_length(v_out, 1), 0) < p_count then
    raise exception 'daily_quest_content_pool_short' using errcode = 'P0001';
  end if;

  return v_out;
end
$fn$;
revoke all on function public._daily_quest_pick_codes(text, text, boolean, int)
  from public, anon, authenticated;

-- Kullanıcının o günkü görev içeriğini döndürür; yoksa seed'le üretip YAZAR.
-- Sonraki attempt'ler AYNI satırı okur → içerik reroll EDİLEMEZ.
create or replace function public._daily_quest_user_content(
  p_quest public.daily_quests,
  p_uid   uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_content jsonb;
  v_seed    text := md5(p_quest.id::text || ':' || p_uid::text);
  v_codes   text[];
  v_row     public.route_duel_pool;
  v_start   text;
  v_target  text;
begin
  select content into v_content
    from public.daily_quest_user_content
   where daily_quest_id = p_quest.id and user_id = p_uid;
  if found then return v_content; end if;

  if p_quest.mode = 'country_write' then
    v_content := '{}'::jsonb;

  elsif p_quest.mode = 'flag_quiz' then
    v_codes := public._daily_quest_pick_codes(
      v_seed,
      p_quest.config->>'region',
      false,
      (p_quest.config->>'total_questions')::int
    );
    v_content := jsonb_build_object('codes', to_jsonb(v_codes));

  elsif p_quest.mode = 'wheel_find' then
    v_codes := public._daily_quest_pick_codes(
      v_seed,
      p_quest.config->>'region',
      true,
      (p_quest.config->>'target_count')::int
    );
    v_content := jsonb_build_object('targets', to_jsonb(v_codes));

  elsif p_quest.mode = 'route_complete' then
    -- Canonical route_duel_pool'dan (CANLI, codegen'li) seed'li deterministik çift.
    select * into v_row
      from public.route_duel_pool p
     where p.intermediates = (p_quest.config->>'intermediates')::int
     order by md5(v_seed || ':' || p.pair_key)
     limit 1;
    if v_row.pair_key is null then
      raise exception 'daily_quest_route_pool_empty' using errcode = 'P0001';
    end if;
    -- Yön de seed'e bağlı (deterministik).
    if (('x' || substr(md5(v_seed || ':dir'), 1, 8))::bit(32)::int % 2) = 0 then
      v_start := v_row.a_key; v_target := v_row.b_key;
    else
      v_start := v_row.b_key; v_target := v_row.a_key;
    end if;
    v_content := jsonb_build_object(
      'pair_key', v_row.pair_key, 'start_key', v_start, 'target_key', v_target
    );
  else
    raise exception 'daily_quest_unknown_mode' using errcode = '22023';
  end if;

  insert into public.daily_quest_user_content (daily_quest_id, user_id, content)
  values (p_quest.id, p_uid, v_content)
  on conflict (daily_quest_id, user_id) do nothing;

  select content into v_content
    from public.daily_quest_user_content
   where daily_quest_id = p_quest.id and user_id = p_uid;
  return v_content;
end
$fn$;
revoke all on function public._daily_quest_user_content(public.daily_quests, uuid)
  from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) İÇ yardımcılar — görünümler (client'a ne döner)
-- ────────────────────────────────────────────────────────────────────────────

-- Attempt'in client'a dönen görünümü. İÇERİK SIZDIRMAZ: bayrak/çark için
-- yalnız MEVCUT sorunun/hedefin kodu döner (gelecek cevaplar gizli kalır).
create or replace function public._daily_quest_attempt_view(
  p_attempt public.daily_quest_attempts,
  p_quest   public.daily_quests,
  p_content jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_view jsonb;
  v_idx  int;
begin
  v_view := jsonb_build_object(
    'id',           p_attempt.id,
    'status',       p_attempt.status,
    'started_at',   p_attempt.started_at,
    'deadline',     p_attempt.deadline,
    'completed_at', p_attempt.completed_at
  );

  if p_quest.mode = 'country_write' then
    v_view := v_view || jsonb_build_object(
      'found_codes', coalesce(p_attempt.progress->'found', '[]'::jsonb),
      'found_count', coalesce(jsonb_array_length(p_attempt.progress->'found'), 0),
      'target',      (p_quest.config->>'target_count')::int
    );

  elsif p_quest.mode = 'flag_quiz' then
    v_idx := coalesce((p_attempt.progress->>'next_index')::int, 0);
    v_view := v_view || jsonb_build_object(
      'next_index',    v_idx,
      'correct_count', coalesce((p_attempt.progress->>'correct')::int, 0),
      'wrong_count',   coalesce((p_attempt.progress->>'wrong')::int, 0),
      'total',         (p_quest.config->>'total_questions')::int,
      'required',      (p_quest.config->>'required_correct')::int,
      'current_code',  case
        when p_attempt.status = 'active' and v_idx < (p_quest.config->>'total_questions')::int
        then p_content->'codes'->>v_idx else null end
    );

  elsif p_quest.mode = 'wheel_find' then
    v_idx := coalesce((p_attempt.progress->>'target_index')::int, 0);
    v_view := v_view || jsonb_build_object(
      'target_index', v_idx,
      'target_count', (p_quest.config->>'target_count')::int,
      'current_code', case
        when p_attempt.status = 'active' and v_idx < (p_quest.config->>'target_count')::int
        then p_content->'targets'->>v_idx else null end
    );

  elsif p_quest.mode = 'route_complete' then
    v_view := v_view || jsonb_build_object(
      'start_key',   p_content->>'start_key',
      'target_key',  p_content->>'target_key',
      'current_key', coalesce(p_attempt.progress->>'current_key', p_content->>'start_key'),
      'path',        coalesce(p_attempt.progress->'path',
                              jsonb_build_array(p_content->>'start_key'))
    );
  end if;

  return v_view;
end
$fn$;
revoke all on function public._daily_quest_attempt_view(public.daily_quest_attempts, public.daily_quests, jsonb)
  from public, anon, authenticated;

-- Süresi geçmiş / eski güne ait aktif attempt'leri kapatır (kullanıcı bazında).
create or replace function public._daily_quest_expire_stale(p_uid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.daily_quest_attempts a
     set status = 'expired'
    from public.daily_quests q
   where q.id = a.daily_quest_id
     and a.user_id = p_uid
     and a.status = 'active'
     and (a.deadline <= now() or q.ends_at <= now());
$$;
revoke all on function public._daily_quest_expire_stale(uuid)
  from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) RPC — daily_quest_get_state(): günün görevi + kullanıcının durumu
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.daily_quest_get_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_quest     public.daily_quests;
  v_attempt   public.daily_quest_attempts;
  v_claim     public.daily_quest_claims;
  v_completed uuid;
  v_content   jsonb;
  v_attempt_v jsonb := null;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;

  begin
    v_quest := public._daily_quest_get_or_create((now() at time zone 'UTC')::date);
  exception when others then
    if sqlerrm like '%daily_quest_pool_exhausted%' then
      return jsonb_build_object('ok', false, 'code', 'daily_quest_pool_exhausted');
    end if;
    raise;
  end;

  perform public._daily_quest_expire_stale(v_uid);

  select * into v_attempt
    from public.daily_quest_attempts
   where daily_quest_id = v_quest.id and user_id = v_uid and status = 'active'
   limit 1;

  if v_attempt.id is not null then
    v_content := public._daily_quest_user_content(v_quest, v_uid);
    v_attempt_v := public._daily_quest_attempt_view(v_attempt, v_quest, v_content);
  end if;

  select id into v_completed
    from public.daily_quest_attempts
   where daily_quest_id = v_quest.id and user_id = v_uid and status = 'completed'
   order by completed_at asc
   limit 1;

  select * into v_claim
    from public.daily_quest_claims
   where daily_quest_id = v_quest.id and user_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'server_now', now(),
    'quest', jsonb_build_object(
      'id', v_quest.id,
      'quest_date', v_quest.quest_date,
      'mode', v_quest.mode,
      'title', v_quest.title,
      'description', v_quest.description,
      'reward_gold', v_quest.reward_gold,
      'starts_at', v_quest.starts_at,
      'ends_at', v_quest.ends_at,
      'config', v_quest.config
    ),
    'attempt', v_attempt_v,
    'completed_attempt_id', v_completed,
    'has_completed', v_completed is not null,
    'has_failed_attempt', exists (
      select 1 from public.daily_quest_attempts
       where daily_quest_id = v_quest.id and user_id = v_uid
         and status in ('failed','abandoned','expired')
    ),
    'claimed', v_claim.id is not null,
    'claimed_at', v_claim.claimed_at
  );
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) RPC — daily_quest_start_attempt(p_resume)
-- ────────────────────────────────────────────────────────────────────────────
-- p_resume=true  → aktif attempt varsa AYNEN döner (sayfa yenileme / devam et).
-- p_resume=false → aktif attempt abandoned yapılır, YENİ attempt açılır
--                  (içerik user_content'ten geldiği için DEĞİŞMEZ → reroll yok).

create or replace function public.daily_quest_start_attempt(
  p_resume boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_quest    public.daily_quests;
  v_attempt  public.daily_quest_attempts;
  v_content  jsonb;
  v_window   int;
  v_deadline timestamptz;
  v_progress jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;

  begin
    v_quest := public._daily_quest_get_or_create((now() at time zone 'UTC')::date);
  exception when others then
    if sqlerrm like '%daily_quest_pool_exhausted%' then
      return jsonb_build_object('ok', false, 'code', 'daily_quest_pool_exhausted');
    end if;
    raise;
  end;

  if now() >= v_quest.ends_at then
    return jsonb_build_object('ok', false, 'code', 'quest_ended');
  end if;

  -- Aynı kullanıcının eşzamanlı start isteklerini serileştir (iki sekme koruması;
  -- partial-unique index ayrıca son savunma hattı).
  perform pg_advisory_xact_lock(
    hashtextextended('daily_quest_attempt:' || v_quest.id::text || ':' || v_uid::text, 0)
  );

  perform public._daily_quest_expire_stale(v_uid);

  if exists (
    select 1 from public.daily_quest_attempts
     where daily_quest_id = v_quest.id and user_id = v_uid and status = 'completed'
  ) then
    return jsonb_build_object('ok', false, 'code', 'already_completed');
  end if;

  select * into v_attempt
    from public.daily_quest_attempts
   where daily_quest_id = v_quest.id and user_id = v_uid and status = 'active'
   for update;

  v_content := public._daily_quest_user_content(v_quest, v_uid);

  if v_attempt.id is not null then
    if p_resume then
      return jsonb_build_object(
        'ok', true, 'resumed', true, 'server_now', now(),
        'quest_id', v_quest.id, 'mode', v_quest.mode, 'config', v_quest.config,
        'attempt', public._daily_quest_attempt_view(v_attempt, v_quest, v_content)
      );
    end if;
    update public.daily_quest_attempts
       set status = 'abandoned'
     where id = v_attempt.id;
  end if;

  -- Attempt penceresi mod'a göre; deadline HER ZAMAN sunucu hesabı ve
  -- görev bitişini aşamaz: min(quest.ends_at, now() + pencere).
  v_window := case v_quest.mode
    when 'country_write'  then (v_quest.config->>'duration_seconds')::int + 10
    when 'flag_quiz'      then (v_quest.config->>'window_seconds')::int
    when 'route_complete' then (v_quest.config->>'deadline_seconds')::int + 5
    when 'wheel_find'     then (v_quest.config->>'total_seconds')::int + 10
  end;
  v_deadline := least(v_quest.ends_at, now() + make_interval(secs => v_window));

  v_progress := case v_quest.mode
    when 'country_write'  then jsonb_build_object('found', '[]'::jsonb)
    when 'flag_quiz'      then jsonb_build_object('next_index', 0, 'correct', 0, 'wrong', 0)
    when 'wheel_find'     then jsonb_build_object('target_index', 0)
    when 'route_complete' then jsonb_build_object(
                                 'current_key', v_content->>'start_key',
                                 'path', jsonb_build_array(v_content->>'start_key'))
  end;

  begin
    insert into public.daily_quest_attempts
      (daily_quest_id, user_id, status, progress, deadline)
    values
      (v_quest.id, v_uid, 'active', v_progress, v_deadline)
    returning * into v_attempt;
  exception when unique_violation then
    -- Yarış: eşzamanlı istek attempt'i bizden önce açtı → onu döndür.
    select * into v_attempt
      from public.daily_quest_attempts
     where daily_quest_id = v_quest.id and user_id = v_uid and status = 'active';
    return jsonb_build_object(
      'ok', true, 'resumed', true, 'server_now', now(),
      'quest_id', v_quest.id, 'mode', v_quest.mode, 'config', v_quest.config,
      'attempt', public._daily_quest_attempt_view(v_attempt, v_quest, v_content)
    );
  end;

  return jsonb_build_object(
    'ok', true, 'resumed', false, 'server_now', now(),
    'quest_id', v_quest.id, 'mode', v_quest.mode, 'config', v_quest.config,
    'attempt', public._daily_quest_attempt_view(v_attempt, v_quest, v_content)
  );
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) İÇ yardımcı — aktif attempt'i sahiplik+durum+süre kontrolüyle kilitle
-- ────────────────────────────────────────────────────────────────────────────
-- Çağrı kuralı: OUT'lardan ikisi rowtype olduğundan PL/pgSQL çoklu INTO
-- listesine ALINAMAZ (42601 "record variable cannot be part of multiple-item
-- INTO list") → çağıran `select * into <record>` + alan-alan atama kullanır.

create or replace function public._daily_quest_lock_active_attempt(
  p_attempt_id uuid,
  p_uid        uuid,
  p_mode       text,
  out o_attempt public.daily_quest_attempts,
  out o_quest   public.daily_quests,
  out o_error   text
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  o_error := null;

  if p_uid is null then o_error := 'unauthenticated'; return; end if;

  -- Sahiplik koşulu SELECT'in içinde: başka kullanıcının attempt_id'si
  -- "yok" gibi davranır (varlık sızdırmaz, ilerletilemez).
  select * into o_attempt
    from public.daily_quest_attempts
   where id = p_attempt_id and user_id = p_uid
   for update;
  if o_attempt.id is null then o_error := 'attempt_not_found'; return; end if;

  select * into o_quest from public.daily_quests where id = o_attempt.daily_quest_id;

  if o_quest.mode <> p_mode then o_error := 'wrong_mode'; return; end if;

  if o_attempt.status <> 'active' then o_error := 'attempt_not_active'; return; end if;

  -- Eski güne ait attempt yeni UTC gününde İLERLEYEMEZ + deadline sunucuda.
  if now() >= o_quest.ends_at or now() > o_attempt.deadline then
    update public.daily_quest_attempts set status = 'expired' where id = o_attempt.id;
    o_error := 'deadline_passed';
    return;
  end if;
end
$fn$;
revoke all on function public._daily_quest_lock_active_attempt(uuid, uuid, text)
  from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) RPC — Ülke Yaz ilerlemesi: daily_quest_submit_country
-- ────────────────────────────────────────────────────────────────────────────
-- Cevaplar TEK TEK gelir; client final skor GÖNDEREMEZ. Kod canonical ülke
-- kataloğuna + görevin kilitli bölgesine karşı doğrulanır; duplicate ülke
-- (alias'lar client'ta canonical koda çözüldüğü için tüm dillerde) SAYILMAZ.

create or replace function public.daily_quest_submit_country(
  p_attempt_id uuid,
  p_code       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_attempt public.daily_quest_attempts;
  v_quest   public.daily_quests;
  v_err     text;
  v_lock    record;
  v_code    text := lower(coalesce(p_code, ''));
  v_country public.daily_quest_country_catalog;
  v_region  text;
  v_found   jsonb;
  v_count   int;
  v_target  int;
  v_done    boolean := false;
begin
  select * into v_lock
    from public._daily_quest_lock_active_attempt(p_attempt_id, v_uid, 'country_write');
  v_attempt := v_lock.o_attempt;
  v_quest   := v_lock.o_quest;
  v_err     := v_lock.o_error;
  if v_err is not null then
    return jsonb_build_object('ok', false, 'code', v_err);
  end if;

  v_target := (v_quest.config->>'target_count')::int;
  v_region := v_quest.config->>'region';
  v_found  := coalesce(v_attempt.progress->'found', '[]'::jsonb);
  v_count  := jsonb_array_length(v_found);

  select * into v_country
    from public.daily_quest_country_catalog
   where code = v_code and counted;
  if v_country.code is null then
    return jsonb_build_object(
      'ok', true, 'accepted', false, 'reason', 'invalid_country',
      'found_count', v_count, 'target', v_target);
  end if;

  if v_region <> 'world' and not (v_region = any(v_country.continents)) then
    return jsonb_build_object(
      'ok', true, 'accepted', false, 'reason', 'wrong_region',
      'found_count', v_count, 'target', v_target);
  end if;

  if v_found ? v_code then
    return jsonb_build_object(
      'ok', true, 'accepted', false, 'reason', 'duplicate',
      'found_count', v_count, 'target', v_target);
  end if;

  v_found := v_found || to_jsonb(v_code);
  v_count := v_count + 1;
  v_done  := v_count >= v_target;

  update public.daily_quest_attempts
     set progress     = jsonb_set(progress, '{found}', v_found),
         status       = case when v_done then 'completed' else status end,
         completed_at = case when v_done then now() else completed_at end
   where id = v_attempt.id;

  return jsonb_build_object(
    'ok', true, 'accepted', true,
    'found_count', v_count, 'target', v_target, 'completed', v_done);
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) RPC — Bayrak ilerlemesi: daily_quest_submit_flag_answer
-- ────────────────────────────────────────────────────────────────────────────
-- Soru sırası sunucuda (user_content.codes, seed'li). p_index mevcut
-- next_index'e eşit olmak ZORUNDA → aynı soruya ikinci cevap / replay
-- ilerletmez. p_code NULL = pas/bilemedi. Client doğru sayısını BELİRLEYEMEZ.

create or replace function public.daily_quest_submit_flag_answer(
  p_attempt_id uuid,
  p_index      int,
  p_code       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_attempt  public.daily_quest_attempts;
  v_quest    public.daily_quests;
  v_err      text;
  v_lock     record;
  v_content  jsonb;
  v_total    int;
  v_required int;
  v_next     int;
  v_correct  int;
  v_wrong    int;
  v_answer   text;
  v_is_ok    boolean;
  v_status   text;
begin
  select * into v_lock
    from public._daily_quest_lock_active_attempt(p_attempt_id, v_uid, 'flag_quiz');
  v_attempt := v_lock.o_attempt;
  v_quest   := v_lock.o_quest;
  v_err     := v_lock.o_error;
  if v_err is not null then
    return jsonb_build_object('ok', false, 'code', v_err);
  end if;

  v_content  := public._daily_quest_user_content(v_quest, v_uid);
  v_total    := (v_quest.config->>'total_questions')::int;
  v_required := (v_quest.config->>'required_correct')::int;
  v_next     := coalesce((v_attempt.progress->>'next_index')::int, 0);
  v_correct  := coalesce((v_attempt.progress->>'correct')::int, 0);
  v_wrong    := coalesce((v_attempt.progress->>'wrong')::int, 0);

  if p_index is distinct from v_next or v_next >= v_total then
    return jsonb_build_object('ok', false, 'code', 'index_mismatch', 'next_index', v_next);
  end if;

  v_answer := v_content->'codes'->>v_next;
  v_is_ok  := p_code is not null and lower(p_code) = v_answer;

  if v_is_ok then v_correct := v_correct + 1; else v_wrong := v_wrong + 1; end if;
  v_next := v_next + 1;

  v_status := case
    when v_correct >= v_required then 'completed'
    when v_wrong > v_total - v_required then 'failed'
    else 'active'
  end;

  update public.daily_quest_attempts
     set progress = jsonb_build_object(
           'next_index', v_next, 'correct', v_correct, 'wrong', v_wrong),
         status       = v_status,
         completed_at = case when v_status = 'completed' then now() else completed_at end
   where id = v_attempt.id;

  return jsonb_build_object(
    'ok', true,
    'correct', v_is_ok,
    'answer_code', v_answer,   -- cevap SONRASI açıklanır (UI "Doğru cevap: X")
    'correct_count', v_correct,
    'wrong_count', v_wrong,
    'next_index', v_next,
    'total', v_total,
    'required', v_required,
    'next_code', case when v_status = 'active' and v_next < v_total
                      then v_content->'codes'->>v_next else null end,
    'completed', v_status = 'completed',
    'failed', v_status = 'failed');
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 13) RPC — Rota ilerlemesi: daily_quest_submit_route_move
-- ────────────────────────────────────────────────────────────────────────────
-- Her hamle CANLI route_duel_graph'a karşı sunucuda doğrulanır. Client
-- current_country / finished GÖNDEREMEZ; hedefe yalnız geçerli komşu
-- zinciriyle ulaşılınca attempt completed olur.

create or replace function public.daily_quest_submit_route_move(
  p_attempt_id  uuid,
  p_country_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_attempt  public.daily_quest_attempts;
  v_quest    public.daily_quests;
  v_err      text;
  v_lock     record;
  v_content  jsonb;
  v_current  text;
  v_target   text;
  v_path     jsonb;
  v_done     boolean := false;
begin
  select * into v_lock
    from public._daily_quest_lock_active_attempt(p_attempt_id, v_uid, 'route_complete');
  v_attempt := v_lock.o_attempt;
  v_quest   := v_lock.o_quest;
  v_err     := v_lock.o_error;
  if v_err is not null then
    return jsonb_build_object('ok', false, 'code', v_err);
  end if;

  v_content := public._daily_quest_user_content(v_quest, v_uid);
  v_current := coalesce(v_attempt.progress->>'current_key', v_content->>'start_key');
  v_target  := v_content->>'target_key';
  v_path    := coalesce(v_attempt.progress->'path',
                        jsonb_build_array(v_content->>'start_key'));

  if p_country_key is null or p_country_key = v_current then
    return jsonb_build_object(
      'ok', true, 'accepted', false, 'reason', 'same_country',
      'current_key', v_current);
  end if;

  -- Komşuluk SUNUCUDA doğrulanır (codegen'li canonical graf).
  if not exists (
    select 1 from public.route_duel_graph g
     where g.country_key = v_current
       and p_country_key = any(g.neighbors)
  ) then
    return jsonb_build_object(
      'ok', true, 'accepted', false, 'reason', 'not_neighbor',
      'current_key', v_current);
  end if;

  v_path := v_path || to_jsonb(p_country_key);
  v_done := p_country_key = v_target;

  update public.daily_quest_attempts
     set progress = jsonb_build_object('current_key', p_country_key, 'path', v_path),
         status       = case when v_done then 'completed' else status end,
         completed_at = case when v_done then now() else completed_at end
   where id = v_attempt.id;

  return jsonb_build_object(
    'ok', true, 'accepted', true,
    'current_key', p_country_key, 'path', v_path, 'completed', v_done);
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 14) RPC — Çark ilerlemesi: daily_quest_submit_wheel_pick
-- ────────────────────────────────────────────────────────────────────────────
-- Hedef dizisi attempt'ten ÖNCE sunucuda (user_content.targets) belirlenir;
-- client hedef listesi gönderemez. Her tıklama SIRADAKİ hedefle karşılaştırılır;
-- yanlış seçim ilerletmez, tamamlanan hedef tekrar tamamlanamaz (index ilerler).

create or replace function public.daily_quest_submit_wheel_pick(
  p_attempt_id uuid,
  p_code       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_attempt public.daily_quest_attempts;
  v_quest   public.daily_quests;
  v_err     text;
  v_lock    record;
  v_content jsonb;
  v_idx     int;
  v_count   int;
  v_target  text;
  v_done    boolean := false;
begin
  select * into v_lock
    from public._daily_quest_lock_active_attempt(p_attempt_id, v_uid, 'wheel_find');
  v_attempt := v_lock.o_attempt;
  v_quest   := v_lock.o_quest;
  v_err     := v_lock.o_error;
  if v_err is not null then
    return jsonb_build_object('ok', false, 'code', v_err);
  end if;

  v_content := public._daily_quest_user_content(v_quest, v_uid);
  v_idx     := coalesce((v_attempt.progress->>'target_index')::int, 0);
  v_count   := (v_quest.config->>'target_count')::int;

  if v_idx >= v_count then
    return jsonb_build_object('ok', false, 'code', 'no_pending_target');
  end if;

  v_target := v_content->'targets'->>v_idx;

  if lower(coalesce(p_code, '')) <> v_target then
    return jsonb_build_object(
      'ok', true, 'correct', false,
      'target_index', v_idx, 'target_count', v_count);
  end if;

  v_idx  := v_idx + 1;
  v_done := v_idx >= v_count;

  update public.daily_quest_attempts
     set progress = jsonb_build_object('target_index', v_idx),
         status       = case when v_done then 'completed' else status end,
         completed_at = case when v_done then now() else completed_at end
   where id = v_attempt.id;

  return jsonb_build_object(
    'ok', true, 'correct', true,
    'found_code', v_target,
    'target_index', v_idx, 'target_count', v_count,
    'next_code', case when not v_done then v_content->'targets'->>v_idx else null end,
    'completed', v_done);
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 15) RPC — daily_quest_claim_reward: idempotent 50 Gold
-- ────────────────────────────────────────────────────────────────────────────
-- Miktar HER ZAMAN daily_quests.reward_gold'dan okunur (client parametresi yok).
-- unique(user_id, daily_quest_id) + FOR UPDATE kilidi: çift tıklama / retry /
-- eşzamanlı iki claim → tek claim satırı, tek gold_transactions kaydı.
-- Gold, mevcut sunucu-otoriter _apply_gold_delta helper'ıyla AYNI transaction
-- içinde yazılır (profiles.gold FOR UPDATE + gold_transactions log).

create or replace function public.daily_quest_claim_reward(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_attempt public.daily_quest_attempts;
  v_quest   public.daily_quests;
  v_gold    int;
  v_claim   public.daily_quest_claims;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  -- Sahiplik SELECT koşulunda: başkasının completed attempt'i claim EDİLEMEZ.
  select * into v_attempt
    from public.daily_quest_attempts
   where id = p_attempt_id and user_id = v_uid
   for update;
  if v_attempt.id is null then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;

  select * into v_quest
    from public.daily_quests
   where id = v_attempt.daily_quest_id
   for update;

  if v_attempt.status <> 'completed' then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_completed');
  end if;

  -- Eski görevin ödülü yeni UTC günü başladıktan sonra ALINAMAZ.
  if now() < v_quest.starts_at or now() >= v_quest.ends_at then
    return jsonb_build_object('ok', false, 'code', 'quest_ended');
  end if;

  -- İdempotens: mevcut claim varsa ikinci ödül YOK, mevcut sonuç döner.
  select * into v_claim
    from public.daily_quest_claims
   where user_id = v_uid and daily_quest_id = v_quest.id;
  if v_claim.id is not null then
    select coalesce(gold, 0) into v_gold from public.profiles where id = v_uid;
    return jsonb_build_object(
      'ok', false, 'code', 'already_claimed',
      'gold', v_gold, 'claimed_at', v_claim.claimed_at);
  end if;

  begin
    insert into public.daily_quest_claims
      (user_id, daily_quest_id, attempt_id, reward_gold)
    values
      (v_uid, v_quest.id, v_attempt.id, v_quest.reward_gold);
  exception when unique_violation then
    -- Yarış: eşzamanlı claim bizden önce yazdı → ikinci award YOK.
    select coalesce(gold, 0) into v_gold from public.profiles where id = v_uid;
    return jsonb_build_object('ok', false, 'code', 'already_claimed', 'gold', v_gold);
  end;

  v_gold := public._apply_gold_delta(
    v_uid,
    v_quest.reward_gold,
    'daily_quest_reward',
    'daily_quest',
    jsonb_build_object(
      'daily_quest_id', v_quest.id,
      'attempt_id', v_attempt.id,
      'quest_date', v_quest.quest_date,
      'mode', v_quest.mode
    )
  );

  return jsonb_build_object(
    'ok', true, 'gold', v_gold, 'amount', v_quest.reward_gold);
end
$fn$;


-- ────────────────────────────────────────────────────────────────────────────
-- 16) Grants — public RPC'ler yalnız authenticated; internals kimseye
-- ────────────────────────────────────────────────────────────────────────────

revoke all on function public.daily_quest_get_state()                          from public, anon;
revoke all on function public.daily_quest_start_attempt(boolean)               from public, anon;
revoke all on function public.daily_quest_submit_country(uuid, text)           from public, anon;
revoke all on function public.daily_quest_submit_flag_answer(uuid, int, text)  from public, anon;
revoke all on function public.daily_quest_submit_route_move(uuid, text)        from public, anon;
revoke all on function public.daily_quest_submit_wheel_pick(uuid, text)        from public, anon;
revoke all on function public.daily_quest_claim_reward(uuid)                   from public, anon;

grant execute on function public.daily_quest_get_state()                         to authenticated;
grant execute on function public.daily_quest_start_attempt(boolean)              to authenticated;
grant execute on function public.daily_quest_submit_country(uuid, text)          to authenticated;
grant execute on function public.daily_quest_submit_flag_answer(uuid, int, text) to authenticated;
grant execute on function public.daily_quest_submit_route_move(uuid, text)       to authenticated;
grant execute on function public.daily_quest_submit_wheel_pick(uuid, text)       to authenticated;
grant execute on function public.daily_quest_claim_reward(uuid)                  to authenticated;


-- ============================================================================
-- Doğrulama (deploy sonrası el ile):
--   select count(*) from public.daily_quest_country_catalog;   -- 196
--   select mode, count(*) from public.daily_quest_templates group by 1;
--     -- country_write 17 / flag_quiz 16 / route_complete 16 / wheel_find 16
--   select public.daily_quest_get_state();
--   select public.daily_quest_start_attempt(false);
--   -- claim çifte çağrı → ikincisi already_claimed, gold TEK artar
-- ============================================================================
