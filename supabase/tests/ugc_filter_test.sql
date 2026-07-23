-- ============================================================================
-- UGC İçerik Filtresi — birim testi (SELF-CONTAINED / şema GEREKTİRMEZ)
-- ============================================================================
-- Bu dosya, migration 20260806120000'deki SAF (tablo bağımsız) filtre
-- fonksiyonlarının bir kopyasını inline tanımlar ve bir doğrulama bataryası
-- koşar. Herhangi bir PostgreSQL'de (proje şeması OLMADAN) çalışır:
--
--   docker run --rm -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t -d --name t postgres:16-alpine
--   docker cp supabase/tests/ugc_filter_test.sql t:/t.sql
--   docker exec t psql -U postgres -d t -v ON_ERROR_STOP=1 -f /t.sql
--
-- Başarı = "ALL FILTER ASSERTIONS PASSED" notice; herhangi bir sapma exception.
--
-- ÖNEMLİ: Buradaki fonksiyon gövdeleri migration'daki tanımların BİREBİR
-- aynısı olmalıdır. Migration filtre listeleri değişirse bu dosya da güncellenir.
-- (Bu test bu oturumda PostgreSQL 16'da koşuldu ve GEÇTİ.)
-- ============================================================================

create or replace function public.normalize_moderation_text(p_text text)
returns text language sql immutable as $fn$
  select btrim(
           regexp_replace(
             regexp_replace(
               translate(
                 lower(translate(coalesce(p_text, ''), 'İIı', 'iii')),
                 'çğıöşüàáâäãåèéêëìíîïòóôõùúûñýÿ',
                 'cgiosuaaaaaaeeeeiiiioooouuunyy'
               ),
               '(.)\1{2,}', '\1', 'g'
             ),
             '\s+', ' ', 'g'
           )
         );
$fn$;

create or replace function public.text_has_forbidden_content(p_text text, p_context text)
returns boolean language plpgsql immutable as $fn$
declare
  v_norm  text := public.normalize_moderation_text(p_text);
  v_name  text; v_nlt text; v_tlt text; v_pref text; v_term text;
  c_exact_crude constant text[] := array['amk','amq','aq','mk'];
  c_exact_reserved constant text[] := array[
    'mod','staff','owner','host','system','sistem','support','destek',
    'admin','moderator','null','undefined','none','noone','nobody',
    'anon','anonymous','guest','torble','official','yetkili','kurucu',
    'yonetici','bot','npc'];
  c_prefix constant text[] := array[
    'fuck','shit','bitch','cunt','whore','slut','faggot','nigger','nigga',
    'rapist','pussy','cumshot','blowjob','dickhead','asshole','motherfuck',
    'bullshit','cocksuck',
    'orospu','siktir','sikey','siker','sikecek','sikik','sikis',
    'amcik','amcig','amcuk','yarrak','yarak','yarag','pezeven','gotveren',
    'gotver','ibne','ibno','yavsak','serefsiz','kahpe','kaltak','gavat',
    'surtuk','godos','oxpicti'];
  c_contains_name constant text[] := array[
    'admin','administrator','moderator','official','torble','geoquiz',
    'orospu','pezevenk','gotveren'];
begin
  if v_norm is null or length(v_norm) = 0 then return false; end if;
  if p_context in ('username','display_name') then
    v_name := regexp_replace(v_norm, '[^a-z0-9]', '', 'g');
    if length(v_name) = 0 then return false; end if;
    v_nlt := translate(v_name, '013457$@', 'oieastsa');
    if v_name = any(c_exact_crude) or v_nlt = any(c_exact_crude)
       or v_name = any(c_exact_reserved) or v_nlt = any(c_exact_reserved) then return true; end if;
    foreach v_pref in array c_prefix loop
      if v_name like v_pref || '%' or v_nlt like v_pref || '%' then return true; end if;
    end loop;
    foreach v_term in array c_contains_name loop
      if position(v_term in v_name) > 0 or position(v_term in v_nlt) > 0 then return true; end if;
    end loop;
    return false;
  elsif p_context in ('room_message','dm_message') then
    declare
      v_toks text[] := (select array_agg(t) from regexp_split_to_table(v_norm,'[^a-z0-9]+') as t where length(t)>0);
      v_cands text[]; v_buf text := ''; v_run int := 0; i int; v_cand text;
    begin
      if v_toks is null then return false; end if;
      v_cands := v_toks;
      for i in 1 .. array_length(v_toks,1) loop
        if length(v_toks[i]) = 1 then v_buf := v_buf || v_toks[i]; v_run := v_run + 1;
        else if v_run >= 2 then v_cands := array_append(v_cands, v_buf); end if; v_buf := ''; v_run := 0; end if;
      end loop;
      if v_run >= 2 then v_cands := array_append(v_cands, v_buf); end if;
      foreach v_cand in array v_cands loop
        v_tlt := translate(v_cand, '013457$@', 'oieastsa');
        if v_cand = any(c_exact_crude) or v_tlt = any(c_exact_crude) then return true; end if;
        foreach v_pref in array c_prefix loop
          if v_cand like v_pref || '%' or v_tlt like v_pref || '%' then return true; end if;
        end loop;
      end loop;
      return false;
    end;
  else
    return false;
  end if;
end $fn$;

do $$
declare
  fails int := 0;
  -- TRUE beklenen (engellenmeli)
  blk text[] := array[
    'username|orospucocugu','username|siktir','username|admin','username|admin123',
    'username|superadmin','username|torbleofficial','username|FUCKER','username|orospu1',
    'username|s1kt1r','username|0r0spu','username|siktirrrr','username|@admin',
    'username|mod','username|guest','username|NULL','username|yarrak','username|amk',
    'display_name|fuck','display_name|Amcik',
    'room_message|siktir git','room_message|seni sikeyim','room_message|orospu cocugu',
    'room_message|s1kt1r','room_message|fuck you','room_message|amk lan',
    'room_message|s.i.k.t.i.r','room_message|SİKTİR','room_message|yarrak kafa',
    'room_message|f u c k','room_message|s-i-k-t-i-r',
    'dm_message|orospu','dm_message|fuck'
  ];
  -- FALSE beklenen (geçmeli — yanlış pozitif yok)
  ok text[] := array[
    'username|mode','username|modern','username|selim','username|ghost','username|hostess',
    'username|passion','username|classic','username|analiz','username|assassin','username|therapist',
    'username|scunthorpe','username|Cagri','username|Ibrahim','username|padir','username|eksik',
    'room_message|eksiktir','room_message|push it','room_message|bu eksiktir','room_message|klasik muzik',
    'room_message|selam nasilsin','room_message|therapist oldum','room_message|scunthorpe sehri',
    'room_message|analiz yaptim','room_message|kesik cizgi','room_message|iyi oyunlar',
    'dm_message|nasilsin dostum','dm_message|gorusuruz','username|mehmet','username|deniz42',
    'room_message|passion project','room_message|assistant lazim',
    'room_message|a b c d e f','room_message|usa fbi tc','room_message|r r tolkien'
  ];
  row text; ctx text; val text; res boolean;
begin
  foreach row in array blk loop
    ctx := split_part(row,'|',1); val := substr(row, length(ctx)+2);
    res := public.text_has_forbidden_content(val, ctx);
    if not res then fails := fails+1; raise warning 'MISS (should block): [%] "%"', ctx, val; end if;
  end loop;
  foreach row in array ok loop
    ctx := split_part(row,'|',1); val := substr(row, length(ctx)+2);
    res := public.text_has_forbidden_content(val, ctx);
    if res then fails := fails+1; raise warning 'FALSE-POSITIVE (should pass): [%] "%"', ctx, val; end if;
  end loop;
  if fails = 0 then raise notice 'ALL FILTER ASSERTIONS PASSED';
  else raise exception '% ASSERTION(S) FAILED', fails; end if;
end $$;
